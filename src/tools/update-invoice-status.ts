import { z } from "zod";
import { ALLOW_REAL_UPDATES, REVIEWED_BY } from "../data.ts";
import { APPROVAL_LIMIT } from "../shared/config.ts";
import { money } from "../shared/format.ts";
import { brief, defineTool } from "./common.ts";

const MAX_NOTE = 500;

export default defineTool({
  name: "update_invoice_status",
  description:
    "Approve or reject ONE flagged invoice. Call it only when the user clearly asks to approve or reject a specific invoice. " +
    "The program itself asks the user to confirm (y/n) and for a short reason before anything changes, so don't ask for either in your reply first. " +
    "Only invoices with status 'flagged' can be changed. Report the outcome exactly as the result says: done true = changed, done false = nothing changed.",
  input: {
    invoice: z.string().min(1).max(100).describe("Invoice number as printed, or the invoice id"),
    action: z.enum(["approve", "reject"]),
  },
  async run({ invoice, action }, { data, confirm, ask }) {
    const found = await data.invoicesByRef(invoice);
    if (!found.length) return { done: false, message: `No invoice "${invoice}" was found. Nothing was changed.` };
    if (found.length > 1) {
      return {
        done: false,
        message: `${found.length} invoices have the number ${invoice}. Ask the user which one, then call again with its id. Nothing was changed.`,
        candidates: found.map(brief),
      };
    }
    const [inv] = found;
    const name = inv.invoice_number ?? inv.id;
    if (inv.status !== "flagged") {
      return { done: false, message: `${name} is already ${inv.status}. Only flagged invoices can be approved or rejected. Nothing was changed.` };
    }
    if (!inv.is_demo && !ALLOW_REAL_UPDATES) {
      return { done: false, message: `${name} is a real (non-demo) invoice, and changing real invoices is turned off (ALLOW_REAL_UPDATES). Nothing was changed.` };
    }
    if (!data.canWrite()) {
      return { done: false, message: "Approving or rejecting needs SUPABASE_SECRET_KEY in .env (the publishable key is read-only). Nothing was changed." };
    }

    const verb = action === "approve" ? "Approve" : "Reject";
    const yes = await confirm(`${verb} ${name} from ${inv.vendor ?? "an unknown vendor"} for ${money(inv.total, inv.currency)}?`);
    if (!yes) return { done: false, message: `The user answered no. ${name} is still flagged. Nothing was changed.` };

    // A reason is required for rejections and for amounts a person must sign off (over the approval limit).
    const required = action === "reject" || Number(inv.total ?? 0) > APPROVAL_LIMIT;
    let note = (await ask(required ? "Reason (required):" : "Reason (optional, press Enter to skip):")).trim();
    if (required && !note) note = (await ask("A reason is required for this one. Reason:")).trim();
    if (required && !note) return { done: false, message: `No reason was given, so ${name} is still flagged. Nothing was changed.` };
    note = note.slice(0, MAX_NOTE);

    const status = action === "approve" ? "approved" : "rejected";
    if (!(await data.setStatus(inv.id, status, note || null))) {
      return { done: false, message: `Nothing was changed: ${name} was no longer flagged (someone may have just reviewed it).` };
    }
    return {
      done: true,
      message: `${name} from ${inv.vendor} (${money(inv.total, inv.currency)}) is now ${status}.`,
      review_note: note || "(none)",
      reviewed_by: REVIEWED_BY,
    };
  },
});
