// The web server with a fake provider: streaming events, the y/n handshake, and the local-only checks.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Provider } from "../src/agent.ts";
import { createApp } from "../src/server.ts";
import type { Context } from "../src/tools/common.ts";
import { fakeData } from "./fake-data.ts";

// A fake "Claude": reports one tool call, asks the user y/n and a reason through ctx, then answers with what it heard.
function fakeProvider(ctx: Context): Provider {
  return {
    name: "fake",
    async ask(question, hooks) {
      hooks?.onToolCall?.("update_invoice_status", { invoice: "SUM-1", action: "approve" });
      const yes = await ctx.confirm("Approve SUM-1 from Summit Logistics for $2,300.00?");
      const note = yes ? await ctx.ask("Reason (optional, press Enter to skip):") : "";
      hooks?.onToolResult?.("update_invoice_status", true, { done: yes });
      return { text: `${question} -> ${yes ? `approved (${note})` : "not approved"}`, toolCalls: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };
}

let base = "";
const server = createApp({ data: fakeData([]), makeProvider: fakeProvider, info: { provider: "", model: "test-model" } });
before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  resolve();
})));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Reads the chat stream and answers each question with the next of `answers`. */
async function chat(message: string, answers: string[]) {
  const res = await post("/api/chat", { message });
  const events: any[] = [];
  let buffer = "";
  for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf("\n")) >= 0; ) {
      const ev = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      events.push(ev);
      if (ev.type === "confirm" || ev.type === "ask") await post("/api/reply", { id: ev.id, value: answers.shift() });
    }
  }
  return events;
}

test("page and info are served with security headers", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Invoice Assistant/);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
  const info = await (await fetch(base + "/api/info")).json();
  assert.equal(info.model, "test-model");
  assert.equal(info.provider, "fake");
  assert.ok(info.tools.includes("reconcile_bank_statement"));
});

test("a turn streams tool steps, asks y/n + reason in the browser, then answers", async () => {
  const events = await chat("Approve SUM-1", ["yes", "Matches the PO"]);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "confirm", "ask", "tool_result", "answer"]);
  assert.equal(events[1].question, "Approve SUM-1 from Summit Logistics for $2,300.00?");
  assert.equal(events.at(-1).text, "Approve SUM-1 -> approved (Matches the PO)");
});

test("answering no means nothing is approved", async () => {
  const events = await chat("Approve SUM-1", ["no"]);
  assert.equal(events.at(-1).text, "Approve SUM-1 -> not approved");
});

test("closing the tab while a confirmation waits counts as no", async () => {
  const res = await post("/api/chat", { message: "Approve SUM-1" }, {});
  const reader = res.body!.getReader();
  await reader.read(); // tool_call / confirm arrive
  await reader.cancel();
  // The server must free itself: a new question works right away.
  await new Promise((r) => setTimeout(r, 50));
  const events = await chat("again", ["no"]);
  assert.equal(events.at(-1).type, "answer");
});

test("only this computer's own pages may call it", async () => {
  const status = (headers: Record<string, string>, method = "GET", path = "/api/info") =>
    new Promise<number>((resolve, reject) => {
      const req = request(base + path, { method, headers }, (res) => (res.resume(), resolve(res.statusCode!)));
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  assert.equal(await status({ Host: "evil.example:80" }), 403); // DNS rebinding
  assert.equal(await status({ Origin: "https://evil.example", "Content-Type": "application/json" }, "POST", "/api/reset"), 403);
  assert.equal((await post("/api/reset", {})).status, 204);
});

test("bad input and unsafe report names are refused", async () => {
  assert.equal((await post("/api/chat", { message: "   " })).status, 400);
  assert.equal((await post("/api/reply", { id: "999", value: "yes" })).status, 404);
  const bad = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + "/api/reports/..%2F.env")).status, 404);
  assert.equal((await fetch(base + "/api/reports/missing.csv")).status, 404);
  assert.equal((await fetch(base + "/server.ts")).status, 404);
});
