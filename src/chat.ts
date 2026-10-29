// The terminal chat:  npm run chat   (add  -- --verbose  to see every tool call and token counts)
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import type { Hooks, Provider } from "./agent.ts";
import { DATA_SCOPE, supabaseData } from "./data.ts";
import { MODEL, createProvider } from "./providers/index.ts";
import { friendly } from "./safety.ts";
import type { Context } from "./tools/common.ts";

const verbose = process.argv.includes("--verbose");

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => bye());
// Reading lines from a queue (not rl.question) also works when questions are piped in: Get-Content demo.txt | npm run chat
const lines = rl[Symbol.asyncIterator]();
async function prompt(label: string) {
  process.stdout.write(label);
  const next = await lines.next();
  if (next.done) return null; // end of input (Ctrl+D, or the end of a piped file)
  if (!process.stdin.isTTY) console.log(next.value); // show piped text as if it was typed
  return next.value.trim();
}
function bye(): never {
  console.log("\nBye.");
  process.exit(0);
}

// The ONE place the y/n question is asked. Tools call it through ctx.confirm in both AI modes.
const ctx: Context = {
  data: supabaseData(),
  confirm: async (question) => /^y(es)?$/i.test((await prompt(styleText("yellow", `\n${question} (y/n) `))) ?? ""),
  ask: async (question) => (await prompt(styleText("yellow", `${question} `))) ?? "",
};

let provider: Provider;
try {
  provider = createProvider(ctx);
} catch (err) {
  console.error(styleText("red", err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

const short = (value: unknown, max = 400) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};
const verboseHooks: Hooks = {
  onToolCall: (name, input) => console.log(styleText("cyan", `  → ${name} ${short(input, 300)}`)),
  onToolResult: (_name, ok, result) => console.log(styleText(ok ? "gray" : "red", `  ← ${ok ? "" : "error: "}${short(result)}`)),
};

console.log(styleText("bold", "Invoice Assistant") + styleText("gray", ` · ${provider.name} · ${MODEL} · data: ${DATA_SCOPE}${verbose ? " · verbose" : ""}`));
console.log(styleText("gray", 'Ask about invoices, vendors, reports or errors. Type "exit" to quit.'));

while (true) {
  const question = await prompt(styleText("green", "\nYou: "));
  if (question == null || /^(exit|quit|bye)$/i.test(question)) bye();
  if (!question) continue;
  if (!verbose) console.log(styleText("gray", "  …"));
  try {
    const answer = await provider.ask(question, verbose ? verboseHooks : undefined);
    console.log(`\n${styleText("bold", "Assistant:")} ${answer.text}`);
    if (verbose) {
      const u = answer.usage;
      const cost = answer.costUsd != null ? ` · est. $${answer.costUsd.toFixed(4)}` : " · subscription (no per-question charge)";
      console.log(styleText("gray", `  [${answer.toolCalls} tool calls · tokens: ${u.input} in, ${u.output} out, ${u.cacheRead} cache read, ${u.cacheWrite} cache write${cost}]`));
    }
  } catch (err) {
    console.log(styleText("red", `\n${friendly(err, "chat")}`));
  }
}
