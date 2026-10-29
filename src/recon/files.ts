// Statement files in, CSV reports out. Statements are only ever read from ONE folder (STATEMENTS_DIR, default ./samples).
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "../safety.ts";
import { toCsv } from "../shared/report.ts";
import { parseDateKey } from "../shared/week.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const REPORTS_DIR = join(ROOT, "reports");

export function statementsDir() {
  return resolve(ROOT, process.env.STATEMENTS_DIR || "samples");
}

/** CSV files in the statements folder (names only). */
export function statementFiles() {
  try {
    return readdirSync(statementsDir()).filter((f) => extname(f).toLowerCase() === ".csv").sort();
  } catch {
    return [];
  }
}

/** Reads a statement by file name, refusing anything outside the statements folder (../, absolute paths, links). */
export function readStatement(file: string) {
  const dir = statementsDir();
  const full = resolve(dir, file);
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(dir, full)) throw new UserError(`For safety, statements can only be read from the statements folder. "${file}" is outside it.`);
  if (extname(full).toLowerCase() !== ".csv") throw new UserError(`Only .csv statement files can be read ("${file}" isn't one).`);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    const available = statementFiles();
    throw new UserError(`Statement file "${file}" wasn't found.${available.length ? ` Available files: ${available.join(", ")}.` : " The statements folder is empty: run npm run seed:recon."}`);
  }
  if (!inside(realpathSync(dir), real)) throw new UserError(`For safety, statements can only be read from the statements folder. "${file}" links outside it.`);
  return readFileSync(real, "utf8");
}

/** Small CSV reader: header row + rows, quoted fields with commas and "" escapes. Returns objects keyed by lowercase header. */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const clean = text.replace(/^﻿/, ""); // Excel adds a byte-order mark
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  const [header = [], ...body] = nonEmpty;
  const keys = header.map((h) => h.trim().toLowerCase());
  return { columns: keys, records: body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()]))) };
}

/** Checks the columns and turns each row into typed values; any bad row is reported with its line number. */
export function readRows<T>(file: string, required: string[], toRow: (r: Record<string, string>) => T) {
  const { columns, records } = parseCsv(readStatement(file));
  const missing = required.filter((c) => !columns.includes(c));
  if (missing.length) {
    throw new UserError(`"${file}" isn't in the expected format: it needs the columns ${required.join(", ")} (missing: ${missing.join(", ")}).`);
  }
  if (!records.length) throw new UserError(`"${file}" has no rows.`);
  return records.map((r, i) => {
    try {
      return toRow(r);
    } catch (err) {
      throw new UserError(`"${file}" line ${i + 2}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** "$1,203.00", "(45.00)", "-45" -> number. */
export function amount(text: string) {
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const value = Number(text.replace(/[()$,\s-]/g, ""));
  if (!text || Number.isNaN(value)) throw new Error(`"${text}" is not an amount`);
  return Math.round((negative ? -value : value) * 100) / 100;
}

export function isoDate(text: string) {
  if (parseDateKey(text) == null) throw new Error(`"${text}" is not a date written as YYYY-MM-DD`);
  return text;
}

/** Writes a CSV report to reports/ and returns its path relative to the project. */
export function saveReport(name: string, rows: (string | number | null)[][]) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = `${name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-${stamp}.csv`;
  writeFileSync(join(REPORTS_DIR, file), toCsv(rows));
  return `reports/${file}`;
}
