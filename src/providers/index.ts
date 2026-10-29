// Picks the "talk to Claude" part from AI_PROVIDER. Used by the chat and the eval.
import { systemPrompt, type Provider } from "../agent.ts";
import type { Context } from "../tools/common.ts";
import { anthropicApi } from "./anthropic-api.ts";
import { claudeCode } from "./claude-code.ts";

export const PROVIDER_NAME = process.env.AI_PROVIDER || "claude-code";
export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

export function createProvider(ctx: Context): Provider {
  const options = { model: MODEL, system: systemPrompt(), ctx };
  if (PROVIDER_NAME === "anthropic-api") return anthropicApi(options);
  if (PROVIDER_NAME === "claude-code") return claudeCode(options);
  throw new Error(`AI_PROVIDER must be claude-code or anthropic-api (it is "${PROVIDER_NAME}").`);
}
