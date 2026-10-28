import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadProject } from "./project";
import { modelFamily } from "./family";

export interface LadderEntry {
  tier: string;
  tries: number;
}

export interface BreakerConfig {
  same_reason: number;
  ignore: string[];
}

export interface EscalationPlan {
  attempts: EscalationAttempt[];
  breaker: BreakerConfig;
}

export interface EscalationAttempt {
  tier: string;
  entry: string;
  provider: string;
  model: string;
  runtime: string;
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

function runtimeForProvider(provider: string): string {
  if (provider === "claude" || provider === "codex" || provider === "agy") return provider;
  return "pi";
}

function splitEntry(entry: string): { provider: string; model: string } {
  const slash = entry.indexOf("/");
  if (slash === -1) return { provider: entry.trim(), model: "" };
  return { provider: entry.slice(0, slash).trim(), model: entry.slice(slash + 1).trim() };
}

export function hasFixedRuntime(root: string, taskTier: string): boolean {
  const project = loadProject(root);
  const runtimes = (project.runtimes ?? {}) as Record<string, unknown>;
  const executor = typeof runtimes.executor === "string" ? runtimes.executor.trim() : "";
  if (executor) return true;
  if (taskTier) {
    const map = runtimes.tier;
    if (map && typeof map === "object") {
      const byTier = (map as Record<string, unknown>)[taskTier];
      if (typeof byTier === "string" && byTier.trim()) return true;
    }
  }
  return false;
}

export function loadEscalation(root: string): EscalationPlan | null {
  const modelsDir = resolveModelsDir(root);
  const routingPath = join(modelsDir, "ROUTING.md");
  if (!existsSync(routingPath)) return null;
  let fm: Record<string, unknown> = {};
  try {
    fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
  } catch {
    return null;
  }
  const ladderRaw = Array.isArray(fm.ladder) ? fm.ladder : [];
  const ladder: LadderEntry[] = [];
  for (const item of ladderRaw) {
    if (item && typeof item === "object") {
      const tier = typeof (item as any).tier === "string" ? (item as any).tier.trim() : "";
      const tries = typeof (item as any).tries === "number" ? (item as any).tries : Number((item as any).tries);
      if (tier && Number.isFinite(tries) && tries > 0) {
        ladder.push({ tier, tries });
      }
    }
  }
  if (ladder.length === 0) return null;
  const breakerRaw = (fm.breaker as Record<string, unknown>) ?? {};
  const sameReason = typeof breakerRaw.same_reason === "number" ? breakerRaw.same_reason : Number(breakerRaw.same_reason);
  const ignoreRaw = Array.isArray(breakerRaw.ignore) ? breakerRaw.ignore : [];
  const ignore = ignoreRaw.map((v) => String(v).trim()).filter(Boolean);
  const breaker: BreakerConfig = {
    same_reason: Number.isFinite(sameReason) && sameReason > 0 ? sameReason : 3,
    ignore,
  };
  const askOwnerRaw = Array.isArray(fm.ask_owner) ? fm.ask_owner : [];
  const askOwner = askOwnerRaw.map((v) => String(v).trim()).filter(Boolean);
  const pools = (fm.pools as Record<string, unknown>) ?? {};
  const executorPools = (pools.executor as Record<string, unknown>) ?? {};
  // Build pool map
  const poolMap: Record<string, string[]> = {};
  for (const [tier, candidates] of Object.entries(executorPools)) {
    if (Array.isArray(candidates)) {
      poolMap[tier] = candidates.map((c) => String(c).trim()).filter(Boolean);
    }
  }
  return { attempts: [], breaker, ladder, pools: poolMap, askOwner } as any;
}

export function buildAttemptPlan(root: string, startTier: string): EscalationAttempt[] {
  const escalation = loadEscalation(root) as any;
  if (!escalation) return [];
  const ladder: LadderEntry[] = escalation.ladder ?? [];
  const poolMap: Record<string, string[]> = escalation.pools ?? {};
  if (ladder.length === 0) return [];
  // Find start index
  let startIdx = ladder.findIndex((e) => e.tier === startTier);
  if (startIdx === -1) startIdx = 0;
  const tried = new Set<string>();
  const attempts: EscalationAttempt[] = [];
  for (let i = startIdx; i < ladder.length; i += 1) {
    const entry = ladder[i]!;
    // strong automático só quando a política do dono prevê runtime_claude (budget/ask_owner).
    if (entry.tier === "strong" && startTier !== "strong" && !(escalation.askOwner ?? []).includes("runtime_claude")) break;
    const candidates = poolMap[entry.tier] ?? [];
    let usedInTier = 0;
    // Try candidates in order, skip if already tried
    for (let c = 0; c < candidates.length && usedInTier < entry.tries; c += 1) {
      const cand = candidates[c]!;
      if (tried.has(cand)) continue;
      tried.add(cand);
      const { provider, model } = splitEntry(cand);
      const runtime = runtimeForProvider(provider);
      attempts.push({ tier: entry.tier, entry: cand, provider, model, runtime });
      usedInTier += 1;
    }
    // If no new candidates in tier (all tried or none available), just move to next tier without consuming tries from exhausted pool?
    // "sem candidato novo no tier, sobe para o próximo (candidato já tentado é pulado)" - so we don't add attempts for exhausted tier, we just continue
    if (usedInTier === 0) continue;
  }
  return attempts;
}

export function getBreaker(root: string): BreakerConfig {
  const escalation = loadEscalation(root) as any;
  if (escalation?.breaker) return escalation.breaker;
  return { same_reason: 3, ignore: ["quota_exhausted", "infra"] };
}
