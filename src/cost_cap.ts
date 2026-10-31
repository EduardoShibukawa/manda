import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  opencodeDb?: string;
  claudeCosts?: number[];
}

function parseSinceMs(since: string): number {
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) return 0;
  return ms;
}

export function spentUsd(input: SpentInput): number {
  const sinceMs = parseSinceMs(input.since);
  let dbSpent = 0;

  const opencodeDb = input.opencodeDb ?? join(process.env.HOME ?? homedir(), ".local", "share", "opencode", "opencode.db");
  if (opencodeDb && existsSync(opencodeDb)) {
    const db = new Database(opencodeDb, { readonly: true, create: false });
    try {
      const stmt = db.prepare("SELECT cost, time_created FROM session_v2 WHERE time_created >= ?");
      const rows = stmt.all(sinceMs) as Array<{ cost: number; time_created: number }>;
      for (const row of rows) {
        const cost = typeof row.cost === "number" ? row.cost : Number(row.cost);
        if (Number.isFinite(cost)) {
          dbSpent += cost;
        }
      }
    } catch {
      // ignore DB errors (e.g., empty or corrupted file without session_v2 table)
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

export function loadRoundCapUsd(root: string): number {
  const projectTomlPath = join(root, ".ginga", "project.toml");
  if (!existsSync(projectTomlPath)) {
    return Infinity;
  }
  try {
    const content = readFileSync(projectTomlPath, "utf8");
    const parsed = Bun.TOML.parse(content) as Record<string, any>;
    if (parsed && typeof parsed === "object" && parsed.budget && typeof parsed.budget.round_usd !== "undefined") {
      const val = Number(parsed.budget.round_usd);
      if (Number.isFinite(val)) {
        return val;
      }
    }
    return Infinity;
  } catch {
    return Infinity;
  }
}

export function isPaidModel(model: string | undefined | null): boolean {
  if (typeof model !== "string" || model.length === 0) {
    return true;
  }
  if (model.startsWith("pi:")) {
    return false;
  }
  if (/[-:]free$/i.test(model)) {
    return false;
  }
  return true;
}

export interface CheckPaidCallOptions {
  root: string;
  since: string;
  next_estimate_usd: number;
  model?: string | null;
  opencodeDb?: string;
  claudeCosts?: number[];
  costCmd?: string[];
}

export function checkPaidCall(o: CheckPaidCallOptions): CapResult {
  if (!isPaidModel(o.model)) {
    return { allow: true, reason: "modelo free" };
  }

  const cap = loadRoundCapUsd(o.root);
  const cmd = o.costCmd ?? ["ginga", "cost", "--json"];

  let spent_usd = 0;
  try {
    const proc = Bun.spawnSync(cmd, {
      cwd: o.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const out = proc.stdout.toString();
      try {
        const parsed = JSON.parse(out);
        if (parsed && typeof parsed.spent_usd === "number") {
          spent_usd = parsed.spent_usd;
        } else if (parsed && typeof parsed.spent_usd !== "undefined") {
          const n = Number(parsed.spent_usd);
          if (Number.isFinite(n)) {
            spent_usd = n;
          }
        } else {
          throw new Error("invalid json");
        }
      } catch {
        throw new Error("parse failed");
      }
    } else {
      throw new Error("command failed");
    }
  } catch {
    const opencodeDb = o.opencodeDb ?? join(process.env.HOME ?? homedir(), ".local", "share", "opencode", "opencode.db");
    spent_usd = spentUsd({
      since: o.since,
      opencodeDb,
      claudeCosts: o.claudeCosts ?? [],
    });
  }

  return capCheck({ spent_usd, next_estimate_usd: o.next_estimate_usd, cap_usd: cap });
}

export function extractTotalCostUsd(output: string): number | undefined {
  if (!output) return undefined;
  let last: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.total_cost_usd === "number" && Number.isFinite(obj.total_cost_usd)) {
        last = obj.total_cost_usd;
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return last;
}
