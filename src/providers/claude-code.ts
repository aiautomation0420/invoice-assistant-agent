// AI_PROVIDER=claude-code: your Claude subscription, through the Claude Agent SDK (it runs Claude Code, logged in as you).
// Claude Code runs the agent loop; our tools run inside THIS program as an in-process tool server, so the
// y/n confirmation can read your keyboard. Claude Code's own tools (files, shell, web) are all switched off.
import { createSdkMcpServer, query, tool, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_TOOL_CALLS, toolRunnerFor, type Hooks, type Provider } from "../agent.ts";
import { UserError, logError } from "../safety.ts";
import type { Context } from "../tools/common.ts";
import { TOOLS } from "../tools/index.ts";

const SERVER = "invoice"; // Claude sees our tools as mcp__invoice__<name>
const NOT_LOGGED_IN = /log ?in|authenticat|api key|oauth|credential/i;

export function claudeCode(options: { model: string; system: string; ctx: Context }): Provider {
  let run = toolRunnerFor(options.ctx); // replaced for every question (fresh call count + hooks)
  const server = createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    timeout: 10 * 60_000, // the y/n prompt may wait for you
    tools: TOOLS.map((t) =>
      tool(t.name, t.description, t.input, async (args) => {
        const { ok, result } = await run.run(t.name, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !ok };
      }),
    ),
  });
  let sessionId: string | undefined; // resuming the same session keeps the conversation history

  return {
    name: "claude-code",
    async ask(question, hooks?: Hooks) {
      run = toolRunnerFor(options.ctx, hooks);
      let result: SDKResultMessage | undefined;
      try {
        for await (const message of query({
          prompt: question,
          options: {
            model: options.model,
            systemPrompt: options.system,
            tools: [], // no built-in Claude Code tools at all: no files, shell, web
            mcpServers: { [SERVER]: server },
            allowedTools: TOOLS.map((t) => `mcp__${SERVER}__${t.name}`),
            permissionMode: "dontAsk", // anything not allowed above is denied, never prompted
            strictMcpConfig: true, // ignore any other MCP servers configured on this computer
            settingSources: [], // ignore your personal Claude Code settings, CLAUDE.md, plugins and hooks
            maxTurns: MAX_TOOL_CALLS + 3,
            resume: sessionId,
            env: childEnv(),
          },
        })) {
          if (message.type === "result") result = message;
        }
      } catch (err) {
        logError("claude-code", err);
        throw new UserError(
          "Couldn't run Claude Code. Make sure you're logged in: open a terminal, run `claude`, type /login, then try again. Details are in logs/app.log.",
        );
      }
      if (!result) throw new UserError("Claude Code ended without an answer. Please try again.");
      sessionId = result.session_id;

      if (result.subtype === "error_max_turns") {
        throw new UserError(`I stopped at the safety limit of ${MAX_TOOL_CALLS} tool calls without an answer. Please ask a narrower question.`);
      }
      const text = result.subtype === "success" ? result.result : result.errors.join("\n");
      if (result.is_error || result.subtype !== "success") {
        logError("claude-code result", { subtype: result.subtype, text });
        if (NOT_LOGGED_IN.test(text)) {
          throw new UserError("Claude Code isn't logged in. Open a terminal, run `claude`, type /login, then try again.");
        }
        throw new UserError("Claude (via Claude Code) couldn't answer right now. Please try again in a minute. Details are in logs/app.log.");
      }
      const u = result.usage;
      return {
        text,
        toolCalls: run.calls(),
        usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens },
      };
    },
  };
}

/** Claude Code runs as a separate process. It gets no API key (so it uses your subscription login) and no Supabase keys. */
function childEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|SUPABASE_)/.test(key)) env[key] = value;
  }
  return { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "invoice-assistant-agent/0.1" };
}
