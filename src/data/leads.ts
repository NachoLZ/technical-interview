import fs from "node:fs";
import path from "node:path";
import type { Lead } from "@/types";

const file = path.join(process.cwd(), "data", "leads.csv");
const raw = fs.readFileSync(file, "utf8");

function parse_csv(csv: string): Lead[] {
  const lines = csv.trim().split("\n");
  const headers = parse_row(lines[0]);

  return lines.slice(1).map((line, i) => {
    const values = parse_row(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = values[j] ?? ""));

    return {
      id: `lead-${i + 1}`,
      first_name: row.lead_first_name ?? "",
      last_name: row.lead_last_name ?? "",
      job_title: row.lead_job_title ?? "",
      company: row.account_name ?? "",
      domain: row.account_domain ?? "",
      employee_range: row.account_employee_range ?? "",
      industry: row.account_industry ?? "",
    };
  });
}

/** Handles quoted fields (e.g. "VP of Sales, North America"). */
function parse_row(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let in_quotes = false;

  for (const char of line) {
    if (char === '"') {
      in_quotes = !in_quotes;
    } else if (char === "," && !in_quotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

export const LEADS: Lead[] = parse_csv(raw);
