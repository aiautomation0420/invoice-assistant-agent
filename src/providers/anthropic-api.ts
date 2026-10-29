// AI_PROVIDER=anthropic-api: the agent loop written out by hand with the official Anthropic SDK.
//
//   1. Send the conversation + the tool list to Claude.
//   2. If Claude answers with text only, that's the final answer.
//   3. If Claude asks for tools (stop_reason "tool_use"): check the input, run each tool, send the results back. Go to 1.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MAX_TOOL_CALLS, toolRunnerFor, type Answer, type Provider, type Usage } from "../agent.ts";
import { UserError, logError } from "../safety.ts";
import type { Context } from "../tools/common.ts";
import { TOOLS } from "../tools/index.ts";

type Client = Pick<Anthropic, "beta">;

// USD per million tokens. Cache reads cost 0.1x input, cache writes 1.25x.
// shortcut: copied from the Claude price list (Oct 2026); update it when you change models or prices change.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

// One answer may take a few rounds (Claude can call several tools per round). This stops a runaway loop.
const MAX_ROUNDS = MAX_TOOL_CALLS + 2;

export function anthropicApi(options: { model: string; system: string; ctx: Context; client?: Client }): Provider {
  if (!options.client && !process.env.ANTHROPIC_API_KEY) {
    throw new UserError("AI_PROVIDER=anthropic-api needs ANTHROPIC_API_KEY in .env. To use your Claude subscription instead, set AI_PROVIDER=claude-code.");
  }
  // The SDK itself retries busy/timeout errors (429, 5xx, connection) with a short wait.
  const client = options.client ?? new Anthropic({ maxRetries: 3, timeout: 120_000 });
  const tools = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // io "input": fields with a default are optional for Claude, the default is filled in by our own check.
    input_schema: z.toJSONSchema(z.object(tool.input), { io: "input" }) as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const history: Anthropic.Beta.BetaMessageParam[] = []; // the whole session, so follow-ups work

  return {
    name: "anthropic-api",
    async ask(question, hooks) {
      const start = history.length;
      const tool = toolRunnerFor(options.ctx, hooks);
      const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      history.push({ role: "user", content: question });
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await client.beta.messages.create({
            model: options.model,
            max_tokens: 16_000,
            system: options.system,
            tools,
            messages: history,
            output_config: { effort: "medium" }, // picking tools and explaining doesn't need deep thinking
            cache_control: { type: "ephemeral" }, // re-use the system prompt + tools + history between rounds
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default", // if a safety check declines, Anthropic retries on its recommended model
          });
          addUsage(usage, response.usage);

          if (response.stop_reason === "refusal") {
            history.length = start; // a declined turn has no usable content to keep
            return answer("Claude declined to answer that. Try asking in a different way.", tool.calls(), usage, options.model);
          }
          history.push({ role: "assistant", content: response.content }); // keep it all, thinking blocks included
          if (response.stop_reason !== "tool_use") {
            const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
            const cut = response.stop_reason === "max_tokens" ? "\n\n(The answer was cut off because it got too long.)" : "";
            return answer(text + cut, tool.calls(), usage, options.model);
          }

          // Claude asked for tools: run every one, then send all results back together in one message.
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const { ok, result } = await tool.run(block.name, block.input);
            results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result), is_error: !ok });
          }
          history.push({ role: "user", content: results });
        }
        throw new UserError(`I stopped after ${MAX_ROUNDS} rounds of tool calls without an answer. Please ask a narrower question.`);
      } catch (err) {
        history.length = start; // drop the half-finished turn so the next question starts clean
        throw toFriendly(err);
      }
    },
  };
}

function addUsage(total: Usage, u: Anthropic.Beta.BetaUsage) {
  total.input += u.input_tokens;
  total.output += u.output_tokens;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

function answer(text: string, toolCalls: number, usage: Usage, model: string): Answer {
  const price = PRICES[model];
  const costUsd = price && (usage.input * price.input + usage.cacheWrite * price.input * 1.25 + usage.cacheRead * price.input * 0.1 + usage.output * price.output) / 1e6;
  return { text, toolCalls, usage, costUsd };
}

function toFriendly(err: unknown) {
  if (err instanceof UserError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new UserError("The Anthropic API rejected ANTHROPIC_API_KEY. Check the key in .env.");
  if (err instanceof Anthropic.PermissionDeniedError) return new UserError("This API key isn't allowed to use that model. Check CLAUDE_MODEL in .env.");
  if (err instanceof Anthropic.NotFoundError) return new UserError("That model wasn't found. Check CLAUDE_MODEL in .env.");
  logError("anthropic-api", err);
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new UserError("Claude is busy or can't be reached right now (I already retried). Please try again in a minute.");
  }
  return new UserError("Something went wrong talking to Claude. The details were saved to logs/app.log.");
}
