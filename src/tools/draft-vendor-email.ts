import { z } from "zod";
import { vendorRecon } from "../recon/run.ts";
import { UserError } from "../safety.ts";
import { money } from "../shared/format.ts";
import { defineTool } from "./common.ts";

const KINDS = ["missing_in_our_records", "missing_from_their_statement", "amount_difference", "unapplied_payment", "rejected_by_us"] as const;
type Kind = (typeof KINDS)[number];

const SECTIONS: Record<Kind, string> = {
  missing_in_our_records: "Items on your statement that we don't have on file. Please send us a copy of each so we can process it:",
  missing_from_their_statement: "Invoices we received from you that aren't on your statement. Please confirm whether they are in your system:",
  amount_difference: "Amounts on your statement that differ from what we have. Please send a corrected invoice or a credit memo, or the remittance correction:",
  unapplied_payment: "Payments we sent that aren't shown on your statement. Please apply them to our account:",
  rejected_by_us: "Invoices we rejected. Please remove them from our account or issue a credit memo:",
};

type Item = { kind: Kind; reference: string; date?: string | null; ours?: number | null; theirs?: number | null; note?: string };

function line(item: Item) {
  const when = item.date ? `, dated ${item.date}` : "";
  if (item.kind === "amount_difference" && item.ours != null && item.theirs != null) {
    return `- ${item.reference}${when}: your statement shows ${money(item.theirs)}, our records show ${money(item.ours)}`;
  }
  const value = item.theirs ?? item.ours;
  return `- ${item.reference}${when}${value != null ? `, ${money(value)}` : ""}${item.note ? ` (${item.note})` : ""}`;
}

export default defineTool({
  name: "draft_vendor_email",
  description:
    "Write the TEXT of an email to a vendor (it never sends anything). Best used with statement_file: the items are taken straight from the " +
    "reconciliation of that statement, e.g. to request copies of invoices we're missing or ask them to apply our payments. Use `include` " +
    "to pick which kinds of differences to mention (default: all). Without a statement, pass `items` from earlier tool results. " +
    "Show the draft to the user and say it was not sent.",
  input: {
    vendor: z.string().min(1).max(100).describe("Vendor name, e.g. 'Summit Logistics'"),
    statement_file: z.string().max(200).optional().describe("Vendor statement file to take the differences from"),
    include: z.array(z.enum(KINDS)).optional().describe("Which kinds of differences to include, e.g. ['missing_in_our_records'] for 'ask for the missing invoices'"),
    items: z
      .array(z.object({ kind: z.enum(KINDS), reference: z.string().max(100), date: z.string().max(10).optional(), ours: z.number().optional(), theirs: z.number().optional(), note: z.string().max(200).optional() }))
      .max(50)
      .optional()
      .describe("Items to mention when there is no statement file; copy them exactly from earlier tool results"),
    extra_message: z.string().max(1000).optional().describe("Optional sentence(s) to add before the sign-off"),
  },
  async run(args, { data }) {
    let vendor = args.vendor;
    let period = "";
    let items: Item[];
    if (args.statement_file) {
      const r = await vendorRecon(data, args.statement_file, args.vendor);
      vendor = r.vendor;
      period = ` (${r.period.from} to ${r.period.to})`;
      items = r.differences;
    } else if (args.items?.length) {
      items = args.items;
    } else {
      throw new UserError("Give a statement_file (recommended) or the items to mention.");
    }
    const kinds = (args.include?.length ? args.include : KINDS).filter((k) => items.some((i) => i.kind === k));
    if (!kinds.length) return { drafted: false, message: `There is nothing to ask ${vendor} about for the chosen items. Nothing was drafted.` };

    const topics: Record<Kind, string> = {
      missing_in_our_records: "copies of missing invoices",
      missing_from_their_statement: "invoices not on your statement",
      amount_difference: "amount differences",
      unapplied_payment: "payments to apply",
      rejected_by_us: "rejected invoices",
    };
    const subject = `Statement reconciliation${period}: ${kinds.map((k) => topics[k]).join(", ")}`;
    const body = [
      `Hello ${vendor} Accounts Receivable team,`,
      "",
      `We reconciled your statement${period} against our records and need your help with the following.`,
      ...kinds.flatMap((k) => ["", SECTIONS[k], ...items.filter((i) => i.kind === k).map(line)]),
      ...(args.extra_message ? ["", args.extra_message] : []),
      "",
      "Thank you for your help. Please reply to this email with the documents or confirmations.",
      "",
      "Kind regards,",
      "[Your name]",
      "Accounts Payable",
    ].join("\n");
    return { drafted: true, sent: false, to: `${vendor} (Accounts Receivable)`, subject, body, note: "Draft only. Nothing was sent." };
  },
});
