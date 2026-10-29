// Friendly errors for the user, full details only in logs/app.log, and no keys anywhere.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The desktop app sets INVOICE_ASSISTANT_DATA to its own writable folder; otherwise logs/ sits in the project.
const LOG_DIR = join(process.env.INVOICE_ASSISTANT_DATA || join(import.meta.dirname, ".."), "logs");

/** A problem the user (or Claude) can fix. Its message is safe to show as-is. */
export class UserError extends Error {}

// Supabase keys (sb_..., old JWT-style keys) and Anthropic keys.
const SECRETS = /\b(?:sb_secret_|sb_publishable_|sk-ant-)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

export function redact(text: string) {
  return text.replace(SECRETS, "[hidden]");
}

export function logError(where: string, err: unknown) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "app.log"), `[${new Date().toISOString()}] ${where}: ${redact(detail)}\n`);
  } catch {
    // Logging must never crash the chat.
  }
}

/** The message to show for any error: UserError text, or a generic line with the details logged. */
export function friendly(err: unknown, where: string) {
  if (err instanceof UserError) return err.message;
  logError(where, err);
  return "Something went wrong reading the invoice data. The details were saved to logs/app.log.";
}
