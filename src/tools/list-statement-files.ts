import { parseCsv, readStatement, statementFiles } from "../recon/files.ts";
import { defineTool } from "./common.ts";

export default defineTool({
  name: "list_statement_files",
  description:
    "List the statement CSV files available for reconciliation (vendor statements and bank statements), with the kind of each file. " +
    "Call it first when the user asks to reconcile a statement, to find the right file name.",
  input: {},
  async run() {
    const files = statementFiles().map((file) => {
      const { columns, records } = parseCsv(readStatement(file));
      const kind = columns.includes("type") ? "vendor statement" : columns.includes("description") ? "bank statement" : "unknown format";
      const dates = records.map((r) => r.date).filter(Boolean).sort();
      return { file, kind, lines: records.length, dates: dates.length ? `${dates[0]} to ${dates.at(-1)}` : "—" };
    });
    if (!files.length) return { files: [], message: "No statement files found. Run npm run seed:recon to create the sample statements." };
    return { files };
  },
});
