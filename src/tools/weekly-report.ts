import { UserError } from "../safety.ts";
import { weekLabel } from "../shared/format.ts";
import { flagRows, metrics, summarize } from "../shared/report.ts";
import { WEEK, dateKey, parseDateKey, weekStart } from "../shared/week.ts";
import { day, defineTool } from "./common.ts";

export default defineTool({
  name: "weekly_report",
  description:
    "The dashboard's weekly report for one week (Monday to Sunday, Asia/Manila), compared with the week before: invoices processed, clean, " +
    "flagged, approved, rejected, clean rate, flag rate, total amount (rejected left out), hours saved, and the top flag reasons. " +
    "An invoice belongs to the week it was processed. Leave out `week` for the last full week ('last week').",
  input: {
    week: day.optional().describe("Any date in the week, YYYY-MM-DD. Leave out for last week."),
  },
  async run({ week }, { data }) {
    const thisWeek = weekStart(Date.now());
    const start = week ? weekStart(parseDateKey(week)!) : thisWeek - WEEK;
    if (start > thisWeek) throw new UserError("That week hasn't started yet.");

    const rows = await data.invoices({ createdFrom: start - WEEK, createdTo: start + WEEK });
    const inWeek = (row: { created_at: string }) => Date.parse(row.created_at) >= start;
    const current = summarize(rows.filter(inWeek));
    const previous = summarize(rows.filter((r) => !inWeek(r)));

    return {
      week: weekLabel(dateKey(start)),
      ...(start === thisWeek && { note: "This week isn't over yet, so the numbers are still growing." }),
      metrics: metrics(current, previous).map((m) => ({ metric: m.label, this_week: m.now, week_before: m.before, change: m.change ?? "—" })),
      flag_reasons: flagRows(current, previous).map((f) => ({ reason: f.label, this_week: f.now, week_before: f.before })),
    };
  },
});
