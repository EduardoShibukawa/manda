import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface BudgetConfig {
  task_usd: number;
  plan_usd: number;
  month_usd: number;
  warn_pct: number;
}

export interface Spend {
  task: number;
  plan: number;
  month: number;
}

export interface SpendEntry {
  ts: string;
  plan: string;
  task: string;
  cost_usd: number;
  cost_source: string;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = text.slice(3, end).trim();
  if (!yaml) return {};
  try {
    const parsed = Bun.YAML.parse(yaml);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadRawProject(root: string): Record<string, unknown> {
  const p = join(root, ".ginga", "project.toml");
  if (!existsSync(p)) return {};
  try {
    return Bun.TOML.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveModelsDir(root: string): string {
  const raw = loadRawProject(root);
  const routing = (raw.routing as Record<string, unknown>) ?? {};
  const configured = typeof routing.models === "string" ? routing.models.trim() : "";
  if (configured) {
    return isAbsolute(configured) ? configured : join(root, configured);
  }
  return join(process.env.HOME ?? "", ".config", "ginga", "models");
}

function finiteNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadBudgetConfig(root: string): BudgetConfig {
  const modelsDir = resolveModelsDir(root);
  const routingPath = join(modelsDir, "ROUTING.md");
  let fm: Record<string, unknown> = {};
  if (existsSync(routingPath)) {
    try {
      fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
    } catch {
      fm = {};
    }
  }
  const b = (fm.budget as Record<string, unknown>) ?? {};
  return {
    task_usd: finiteNumber(b.task_usd, Infinity),
    plan_usd: finiteNumber(b.plan_usd, Infinity),
    month_usd: finiteNumber(b.month_usd, Infinity),
    warn_pct: finiteNumber(b.warn_pct, 80),
  };
}

export function loadAskOwner(root: string): string[] {
  const modelsDir = resolveModelsDir(root);
  const routingPath = join(modelsDir, "ROUTING.md");
  if (!existsSync(routingPath)) return [];
  try {
    const fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
    const raw = Array.isArray(fm.ask_owner) ? fm.ask_owner : [];
    return raw.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function spendFilePath(root: string): string {
  return join(root, ".ginga", "state", "manda-spend.jsonl");
}

function monthKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonthKey(): string {
  return monthKey(new Date().toISOString());
}

export function computeSpendFromJsonl(root: string, plan: string, task: string): Spend {
  const p = spendFilePath(root);
  const result: Spend = { task: 0, plan: 0, month: 0 };
  if (!existsSync(p)) return result;
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return result;
  }
  const cur = currentMonthKey();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (obj.cost_source !== "metered") continue;
    const cost = Number(obj.cost_usd);
    if (!Number.isFinite(cost)) continue;
    if (obj.plan === plan && obj.task === task) result.task += cost;
    if (obj.plan === plan) result.plan += cost;
    if (monthKey(String(obj.ts ?? "")) === cur) result.month += cost;
  }
  return result;
}

export function runSpendCmd(cmd: string, plan: string, task: string): Spend {
  const result: Spend = { task: 0, plan: 0, month: 0 };
  try {
    const r = Bun.spawnSync(["bash", "-c", cmd], {
      env: { ...process.env, MANDA_PLAN: plan, MANDA_TASK: task },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString().trim();
    const lines = out.split("\n").filter((l) => l.trim());
    const last = lines.length ? lines[lines.length - 1]!.trim() : "";
    const obj = JSON.parse(last);
    if (obj && typeof obj === "object") {
      result.task = Number((obj as any).task) || 0;
      result.plan = Number((obj as any).plan) || 0;
      result.month = Number((obj as any).month) || 0;
    }
  } catch {
    // keep zeros on failure
  }
  return result;
}

export function appendSpend(root: string, entry: SpendEntry): void {
  const p = spendFilePath(root);
  mkdirSync(join(root, ".ginga", "state"), { recursive: true });
  appendFileSync(p, `${JSON.stringify(entry)}\n`);
}
