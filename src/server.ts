// The web app's server: plain node:http, local only. Same agent, tools and safety rules as the terminal chat.
//   POST /api/chat   streams one turn as lines of JSON: tool_call, tool_result, confirm, ask, answer, error
//   POST /api/reply  answers a confirm (y/n) or ask (reason) that a tool is waiting on
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Provider } from "./agent.ts";
import { DATA_SCOPE, type Data } from "./data.ts";
import { REPORTS_DIR } from "./recon/files.ts";
import { friendly } from "./safety.ts";
import type { Context } from "./tools/common.ts";
import { TOOLS } from "./tools/index.ts";

const WEB_DIR = join(import.meta.dirname, "..", "web");
const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const MAX_BODY = 64 * 1024;
const MAX_MESSAGE = 4000;
const REPLY_TIMEOUT_MS = 10 * 60_000; // an unanswered y/n counts as "no"
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin", // other websites can't load anything from here
  "Cross-Origin-Opener-Policy": "same-origin",
};

type Event = { type: string } & Record<string, unknown>;
export type AppInfo = { provider: string; model: string; statementMonth?: string };

export function createApp(options: { data: Data; makeProvider: (ctx: Context) => Provider; info: AppInfo }) {
  let send: ((event: Event) => void) | null = null; // the open /api/chat stream, if any
  const pending = new Map<string, (value: string) => void>();
  let nextId = 0;

  // A tool asks the person in the browser and waits. No browser, a closed tab or a timeout all mean "no" / "".
  const waitForUser = (type: "confirm" | "ask", question: string) =>
    new Promise<string>((resolve) => {
      if (!send) return resolve("");
      const id = String(++nextId);
      const finish = (value: string) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish(""), REPLY_TIMEOUT_MS);
      pending.set(id, finish);
      send({ type, id, question });
    });
  const cancelPending = () => [...pending.values()].forEach((finish) => finish(""));

  const ctx: Context = {
    data: options.data,
    confirm: async (question) => (await waitForUser("confirm", question)) === "yes",
    ask: (question) => waitForUser("ask", question),
  };
  let provider = options.makeProvider(ctx);
  let busy = false;

  const server = createServer(async (req, res) => {
    try {
      // Only pages served by this app on this computer (blocks other websites and DNS-rebinding tricks).
      const port = (server.address() as AddressInfo).port;
      const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
      if (!allowed.has(req.headers.host ?? "")) return reply(res, 403, "Forbidden");
      if (req.method !== "GET" && !allowed.has(originHost(req.headers.origin) ?? `localhost:${port}`)) return reply(res, 403, "Forbidden");

      const url = new URL(req.url ?? "/", "http://localhost");
      const page = STATIC[url.pathname];
      if (req.method === "GET" && page) {
        res.writeHead(200, { "Content-Type": page[1], "Cache-Control": "no-cache", ...SECURITY_HEADERS });
        return createReadStream(join(WEB_DIR, page[0])).pipe(res);
      }

      if (req.method === "GET" && url.pathname === "/api/info") {
        return json(res, 200, { ...options.info, provider: provider.name, scope: DATA_SCOPE, tools: TOOLS.map((t) => t.name) });
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/reports/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/reports/".length));
        const file = join(REPORTS_DIR, name);
        if (!/^[\w.-]+\.csv$/.test(name) || !existsSync(file)) return reply(res, 404, "Report not found");
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, ...SECURITY_HEADERS });
        return createReadStream(file).pipe(res);
      }

      if (req.method === "POST" && url.pathname === "/api/reply") {
        const { id, value } = await body(req);
        const finish = pending.get(String(id));
        if (!finish) return reply(res, 404, "That question is no longer waiting for an answer.");
        finish(String(value ?? "").slice(0, 1000));
        return reply(res, 204);
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        if (busy) return reply(res, 409, "Wait for the current answer to finish.");
        provider = options.makeProvider(ctx);
        return reply(res, 204);
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { message } = await body(req);
        const text = String(message ?? "").trim().slice(0, MAX_MESSAGE);
        if (!text) return reply(res, 400, "Type a question first.");
        if (busy) return reply(res, 409, "Wait for the current answer to finish.");
        busy = true;
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
        const stream = (event: Event) => res.write(JSON.stringify(event) + "\n");
        send = stream;
        res.on("close", () => {
          if (send === stream) send = null;
          cancelPending(); // the tab closed: any waiting approval counts as "no"
        });
        try {
          const answer = await provider.ask(text, {
            onToolCall: (name, input) => send?.({ type: "tool_call", name, input }),
            onToolResult: (name, ok, result) => send?.({ type: "tool_result", name, ok, result }),
          });
          send?.({ type: "answer", ...answer });
        } catch (err) {
          send?.({ type: "error", message: friendly(err, "web chat") });
        } finally {
          busy = false;
          if (send === stream) send = null;
          cancelPending();
          res.end();
        }
        return;
      }

      reply(res, 404, "Not found");
    } catch (err) {
      if (!res.headersSent) reply(res, err instanceof BadRequest ? 400 : 500, err instanceof BadRequest ? err.message : friendly(err, "web"));
      else res.end();
    }
  });
  return server;
}

class BadRequest extends Error {}

function originHost(origin: string | undefined) {
  if (!origin) return undefined; // not a browser request from another site (browsers always send Origin on POST)
  try {
    return new URL(origin).host;
  } catch {
    return "invalid";
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BadRequest("Message too long.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  throw new BadRequest("Expected JSON.");
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(value));
}

function reply(res: ServerResponse, status: number, message = "") {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  res.end(message);
}
