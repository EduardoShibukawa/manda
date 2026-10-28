import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadProject } from "./project";
import { modelFamily } from "./family";

export interface RouteResult {
  runtime: string;
  provider: string;
  model: string;
  family: string;
  source: "project" | "routing";
}

export interface RouteOptions {
  task: string;
  root?: string;
  models?: string;
}

interface RouteOk {
  ok: true;
  result: RouteResult;
}
interface RouteErr {
  ok: false;
  error: string;
}
export type RouteResolution = RouteOk | RouteErr;

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

function resolveModelsDir(opts: RouteOptions, root: string): string {
  if (opts.models) {
    const m = opts.models;
    if (isAbsolute(m)) return m;
    const fromCwd = join(process.cwd(), m);
    if (existsSync(fromCwd)) return fromCwd;
    return join(root, m);
  }
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

export function resolveRoute(opts: RouteOptions): RouteResolution {
  const root = opts.root ?? process.cwd();
  const taskPath = isAbsolute(opts.task) ? opts.task : (() => {
    const fromCwd = join(process.cwd(), opts.task);
    return existsSync(fromCwd) ? fromCwd : join(root, opts.task);
  })();

  if (!existsSync(taskPath)) {
    return { ok: false, error: `task não encontrada: ${opts.task}` };
  }
  let tier = "";
  try {
    const fm = parseFrontmatter(readFileSync(taskPath, "utf8"));
    tier = typeof fm.tier === "string" ? fm.tier.trim() : "";
  } catch {
    return { ok: false, error: `falha ao ler task: ${opts.task}` };
  }

  const project = loadProject(root);
  const runtimes = (project.runtimes ?? {}) as Record<string, unknown>;

  // 1. Pino em [runtimes]
  let pin: string | undefined;
  const executor = typeof runtimes.executor === "string" ? runtimes.executor.trim() : "";
  if (executor) pin = executor;
  else if (tier) {
    const map = runtimes.tier;
    if (map && typeof map === "object") {
      const byTier = (map as Record<string, unknown>)[tier];
      if (typeof byTier === "string" && byTier.trim()) pin = byTier.trim();
    }
  }

  if (pin) {
    let runtime: string;
    let entry: string;
    const colon = pin.indexOf(":");
    if (colon !== -1) {
      runtime = pin.slice(0, colon).trim();
      entry = pin.slice(colon + 1).trim();
    } else {
      entry = pin;
      runtime = runtimeForProvider(splitEntry(entry).provider);
    }
    const { provider, model } = splitEntry(entry);
    if (!runtime) runtime = runtimeForProvider(provider);
    return {
      ok: true,
      result: {
        runtime,
        provider,
        model,
        family: modelFamily(entry),
        source: "project",
      },
    };
  }

  // 2. Pool do ROUTING.md
  const modelsDir = resolveModelsDir(opts, root);
  const routingPath = join(modelsDir, "ROUTING.md");
  if (!existsSync(routingPath)) {
    return { ok: false, error: `sem pino em [runtimes] e pasta de modelos indisponível: ${modelsDir}` };
  }
  let fm: Record<string, unknown> = {};
  try {
    fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
  } catch {
    return { ok: false, error: `falha ao ler ${routingPath}` };
  }
  const pools = (fm.pools as Record<string, unknown>) ?? {};
  const executorPools = (pools.executor as Record<string, unknown>) ?? {};
  const candidates = Array.isArray(executorPools[tier]) ? (executorPools[tier] as unknown[]) : null;
  if (!candidates || candidates.length === 0) {
    return { ok: false, error: `tier sem candidatos no pool: ${tier}` };
  }
  const first = String(candidates[0]).trim();
  const { provider, model } = splitEntry(first);
  const runtime = runtimeForProvider(provider);
  return {
    ok: true,
    result: {
      runtime,
      provider,
      model,
      family: modelFamily(first),
      source: "routing",
    },
  };
}

export function routeMain(argv: string[]): number {
  let task: string | undefined;
  let root = process.cwd();
  let models: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "--models") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("Usage: manda route <TASK> [--json] [--root <dir>] [--models <dir>]");
        return 2;
      }
      if (arg === "--root") root = value;
      else models = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg.startsWith("--models=")) {
      models = arg.slice("--models=".length);
    } else if (arg.startsWith("-")) {
      console.error("Usage: manda route <TASK> [--json] [--root <dir>] [--models <dir>]");
      return 2;
    } else if (task === undefined) {
      task = arg;
    } else {
      console.error("Usage: manda route <TASK> [--json] [--root <dir>] [--models <dir>]");
      return 2;
    }
  }

  if (!task) {
    console.error("Usage: manda route <TASK> [--json] [--root <dir>] [--models <dir>]");
    return 2;
  }

  const res = resolveRoute({ task, root, models });
  if (!res.ok) {
    console.error(res.error);
    // ensure [runtimes] citation when no models
    if (res.error.includes("pasta de modelos") && !res.error.includes("[runtimes]")) {
      console.error("Configure [runtimes] em .ginga/project.toml");
    }
    return 1;
  }
  if (json) console.log(JSON.stringify(res.result));
  else console.log(`${res.result.runtime} ${res.result.provider}/${res.result.model}`);
  return 0;
}
