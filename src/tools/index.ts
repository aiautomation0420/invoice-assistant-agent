// The tool list both AI modes share. To add a tool (e.g. RAG search later): write src/tools/<name>.ts and add it here.
import { z } from "zod";
import { friendly } from "../safety.ts";
import type { Context, Tool } from "./common.ts";
import draftVendorEmail from "./draft-vendor-email.ts";
import getInvoice from "./get-invoice.ts";
import listErrors from "./list-errors.ts";
import listStatementFiles from "./list-statement-files.ts";
import reconcileBankStatement from "./reconcile-bank-statement.ts";
import reconcileVendorStatement from "./reconcile-vendor-statement.ts";
import searchInvoices from "./search-invoices.ts";
import updateInvoiceStatus from "./update-invoice-status.ts";
import vendorSummary from "./vendor-summary.ts";
import weeklyReport from "./weekly-report.ts";

export const TOOLS: Tool[] = [
  // read-only
  searchInvoices,
  getInvoice,
  vendorSummary,
  weeklyReport,
  listErrors,
  listStatementFiles,
  reconcileVendorStatement,
  reconcileBankStatement,
  // actions
  draftVendorEmail, // writes text only
  updateInvoiceStatus, // asks y/n + reason first
];

/**
 * Checks the input, runs the tool, and never throws: bad input and failures come back as
 * { ok: false, result: { error } } so Claude can read the problem and try again.
 */
export async function runTool(name: string, input: unknown, ctx: Context): Promise<{ ok: boolean; result: unknown }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: { error: `There is no tool called "${name}".` } };
  const parsed = z.object(tool.input).safeParse(input ?? {});
  if (!parsed.success) return { ok: false, result: { error: `Invalid input for ${name}:\n${z.prettifyError(parsed.error)}` } };
  try {
    return { ok: true, result: await tool.run(parsed.data, ctx) };
  } catch (err) {
    return { ok: false, result: { error: friendly(err, `tool ${name}`) } };
  }
}
