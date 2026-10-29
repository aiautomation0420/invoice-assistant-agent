import { z } from "zod";
import { dateTime } from "../shared/format.ts";
import { defineTool } from "./common.ts";

export default defineTool({
  name: "list_errors",
  description:
    "Recent failures of the n8n invoice workflow itself (from error_log): when, which workflow and step failed, and the error message. " +
    "Also says how many errors happened in the last 7 days. These are system errors, not flagged invoices.",
  input: {
    limit: z.number().int().min(1).max(25).default(10).describe("How many recent errors to list"),
  },
  async run({ limit }, { data }) {
    const { rows, lastWeek } = await data.errors(limit);
    if (!rows.length) return { errors_last_7_days: 0, message: "No workflow errors have been recorded." };
    return {
      errors_last_7_days: lastWeek,
      errors: rows.map((e) => ({ when: dateTime(e.created_at), workflow: e.workflow, step: e.node, message: e.message })),
    };
  },
});
