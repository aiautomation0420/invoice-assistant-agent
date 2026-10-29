// npm run app   → opens http://localhost:3210 in your browser (add -- --no-open to skip opening it)
// Local only: the server listens on 127.0.0.1, so nothing outside this computer can reach it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { supabaseData } from "./data.ts";
import { MODEL, createProvider } from "./providers/index.ts";
import { createApp } from "./server.ts";

const PORT = Number(process.env.PORT) || 3210;
const keyFile = join(import.meta.dirname, "..", "samples", "planted-differences.json");
const statementMonth = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")).month : undefined;

let server: ReturnType<typeof createApp>;
try {
  server = createApp({ data: supabaseData(), makeProvider: createProvider, info: { provider: "", model: MODEL, statementMonth } });
} catch (err) {
  console.error(styleText("red", err instanceof Error ? err.message : String(err)));
  process.exit(1);
}

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(styleText("red", err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Is the app already open? Or start it with PORT=3211.` : err.message));
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`${styleText("bold", "Invoice Assistant")} is running at ${styleText("cyan", url)}  (Ctrl+C to stop)`);
  if (process.argv.includes("--no-open")) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
