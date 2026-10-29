// The agent loop (API mode) with a fake Claude: scripted responses, no network, no cost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TOOL_CALLS, toolRunnerFor } from "../src/agent.ts";
import { anthropicApi } from "../src/providers/anthropic-api.ts";
import { UserError } from "../src/safety.ts";
import { fakeData, invoice, noAnswer, noConfirm } from "./fake-data.ts";

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };
const toolUse = (id: string, name: string, input: unknown) => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
  usage,
});
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", usage });

/** A fake Anthropic client that replays `script` and records every request it got. */
function fakeClaude(script: unknown[] | (() => unknown)) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: any) => {
          requests.push(structuredClone(params));
          const next = typeof script === "function" ? script() : script.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  return { client: client as never, requests };
}

const data = fakeData([
  invoice({ invoice_number: "HLP-17296", vendor: "Harbor Legal Partners", status: "flagged", total: 10791.08, flag_reasons: ["over_approval_limit"] }),
  invoice({ status: "flagged", total: 300, flag_reasons: ["math_mismatch"] }),
]);
const ctx = { data, confirm: noConfirm, ask: noAnswer };

test("loop: Claude asks for a tool, we run it, send the result back, and Claude answers", async () => {
  const claude = fakeClaude([toolUse("t1", "search_invoices", { status: "flagged" }), text("2 flagged invoices, $11,091.08 in total.")]);
  const agent = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: claude.client });
  const calls: string[] = [];
  const answer = await agent.ask("Which invoices are flagged?", { onToolCall: (name) => calls.push(name) });

  assert.equal(answer.text, "2 flagged invoices, $11,091.08 in total.");
  assert.deepEqual(calls, ["search_invoices"]);
  assert.equal(answer.toolCalls, 1);
  const toolResult = claude.requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "t1");
  assert.equal(toolResult.is_error, false);
  assert.equal(JSON.parse(toolResult.content).matches, 2);
  assert.deepEqual(answer.usage, { input: 200, output: 40, cacheRead: 100, cacheWrite: 0 });
  // Sonnet 5.5: 200 in * $2 + 100 cache read * $0.20 + 40 out * $10, per million
  assert.equal(answer.costUsd!.toFixed(6), ((200 * 2 + 100 * 0.2 + 40 * 10) / 1e6).toFixed(6));
  assert.ok(claude.requests[0].tools.some((t: any) => t.name === "update_invoice_status"));
});

test("history: a follow-up question is sent with the earlier question, tool calls and answer", async () => {
  const claude = fakeClaude([
    toolUse("t1", "search_invoices", { status: "flagged" }),
    text("2 flagged."),
    toolUse("t2", "search_invoices", { status: "flagged", min_total: 5000 }),
    text("1 is over $5,000: HLP-17296."),
  ]);
  const agent = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: claude.client });
  await agent.ask("Which invoices are flagged?");
  const answer = await agent.ask("and which of those are over $5,000?");
  assert.match(answer.text, /HLP-17296/);
  const sent = claude.requests[2].messages;
  assert.equal(sent.length, 5); // question 1, tool call, tool result, answer 1, question 2
  assert.equal(sent[0].content, "Which invoices are flagged?");
  assert.equal(sent[4].content, "and which of those are over $5,000?");
});

test("bad tool input goes back to Claude as an error so it can fix it", async () => {
  const claude = fakeClaude([toolUse("t1", "search_invoices", { status: "paid" }), toolUse("t2", "search_invoices", { status: "approved" }), text("Fixed it.")]);
  const agent = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: claude.client });
  const answer = await agent.ask("Which invoices are paid?");
  const firstResult = claude.requests[1].messages.at(-1).content[0];
  assert.equal(firstResult.is_error, true);
  assert.match(firstResult.content, /status/);
  assert.equal(answer.text, "Fixed it.");
});

test("safety limit: after 8 tool calls the tools answer 'limit reached', and a runaway loop stops", async () => {
  let n = 0;
  const claude = fakeClaude(() => toolUse(`t${++n}`, "list_errors", {}));
  const agent = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: claude.client });
  await assert.rejects(agent.ask("loop forever"), (err) => err instanceof UserError && /stopped/.test(err.message));
  const lastResult = claude.requests.at(-1).messages.at(-1).content[0];
  assert.equal(lastResult.is_error, true);
  assert.match(lastResult.content, /Safety limit reached/);

  // The failed turn is dropped, so the next question starts clean.
  const next = fakeClaude([text("Hello.")]);
  const fresh = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: next.client });
  await fresh.ask("hi");
  assert.equal(next.requests[0].messages.length, 1);
});

test("a Claude error rolls the turn back and becomes a friendly message", async () => {
  const claude = fakeClaude([new Error("socket hang up"), text("Back again.")]);
  const agent = anthropicApi({ model: "claude-sonnet-5-5", system: "test", ctx, client: claude.client });
  await assert.rejects(agent.ask("first"), (err) => err instanceof UserError && /logs\/app\.log/.test(err.message));
  await agent.ask("second");
  assert.equal(claude.requests[1].messages.length, 1);
  assert.equal(claude.requests[1].messages[0].content, "second");
});

test("toolRunnerFor counts calls per question and blocks call number 9", async () => {
  const runner = toolRunnerFor(ctx);
  for (let i = 0; i < MAX_TOOL_CALLS; i++) assert.equal((await runner.run("list_errors", {})).ok, true);
  const ninth = await runner.run("list_errors", {});
  assert.equal(ninth.ok, false);
  assert.equal(runner.calls(), MAX_TOOL_CALLS + 1);
});
