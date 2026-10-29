import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface CapInput {
  spent_usd: number;
  next_estimate_usd: number;
  cap_usd: number;
}

export interface CapResult {
  allow: boolean;
  reason: string;
}

export function capCheck(input: CapInput): CapResult {
  if (input.spent_usd + input.next_estimate_usd > input.cap_usd) {
    return { allow: false, reason: "custo estimado ultrapassaria o teto" };
  }
  return { allow: true, reason: "dentro do teto" };
}

export interface SpentInput {
  since: string;
  opencodeDb: string;
  claudeCosts: number[];
}

function parseSinceMs(since: string): number {
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) return 0;
  return ms;
}

export function spentUsd(input: SpentInput): number {
  const sinceMs = parseSinceMs(input.since);
  let dbSpent = 0;

  if (input.opencodeDb && existsSync(input.opencodeDb)) {
    const db = new Database(input.opencodeDb, { readonly: true, create: false });
    try {
      const stmt = db.prepare("SELECT cost, time_created FROM session_v2 WHERE time_created >= ?");
      const rows = stmt.all(sinceMs) as Array<{ cost: number; time_created: number }>;
      for (const row of rows) {
        const cost = typeof row.cost === "number" ? row.cost : Number(row.cost);
        if (Number.isFinite(cost)) {
          dbSpent += cost;
        }
      }
    } finally {
      db.close();
    }
  }

  let claudeSpent = 0;
  if (Array.isArray(input.claudeCosts)) {
    for (const c of input.claudeCosts) {
      const cost = typeof c === "number" ? c : Number(c);
      if (Number.isFinite(cost)) {
        claudeSpent += cost;
      }
    }
  }

  return dbSpent + claudeSpent;
}
