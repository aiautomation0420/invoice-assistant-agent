// Run one tool from the terminal, no AI involved:
//   npm run tool -- search_invoices status=flagged min_total=5000
//   npm run tool -- get_invoice invoice=SUM-10422
// (key=value pairs avoid PowerShell's JSON quoting problems; numbers and true/false are converted.)
import { supabaseData } from "../src/data.ts";
import { TOOLS, runTool } from "../src/tools/index.ts";

const [name, ...pairs] = process.argv.slice(2);
if (!name) {
  console.log("Usage: npm run tool -- <tool_name> key=value ...\n\nTools:");
  for (const tool of TOOLS) console.log(`  ${tool.name.padEnd(20)} ${Object.keys(tool.input).join(", ") || "(no input)"}`);
  process.exit(0);
}

const input = Object.fromEntries(
  pairs.map((pair) => {
    const [key, ...rest] = pair.split("=");
    const value = rest.join("=");
    return [key, /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value];
  }),
);

const { ok, result } = await runTool(name, input, {
  data: supabaseData(),
  confirm: async () => false, // write tools only run inside the chat, where you can answer y/n
  ask: async () => "",
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = ok ? 0 : 1;
