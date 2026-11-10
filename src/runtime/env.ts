/**
 * Variável de ambiente e stdin padrão para todos os runtimes (PLAN-0029 TASK-05).
 * Previne `scope_drift` por `__pycache__` (PYTHONDONTWRITEBYTECODE=1) e
 * entrada acidental no stdin (SPAWN_STDIN="ignore").
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const SPAWN_STDIN = "ignore" as const;

/** Pasta que contém os repos irmãos (pai do checkout do manda). */
const SIBLINGS = join(import.meta.dir, "..", "..", "..");

/**
 * Checkout do ginga como pasta vizinha (T904): `ginga` (homelab) ou `g-inga`
 * (clone do GitHub), a primeira que tiver `contrib/guard`. Nenhuma: `ginga`,
 * e os adapters falham fechado (`guard_missing`).
 */
export function siblingGuardDir(parent: string = SIBLINGS): string {
  for (const name of ["ginga", "g-inga"]) {
    if (existsSync(join(parent, name, "contrib", "guard"))) return join(parent, name);
  }
  return join(parent, "ginga");
}

/** Raiz do checkout apontado pelo `ginga` do PATH (symlink para
 * `<repo>/bin/ginga.ts`), se ela tiver `contrib/guard`. */
function pathGuardDir(pathEnv: string | undefined): string | null {
  try {
    const bin = Bun.which("ginga", { PATH: pathEnv ?? "" });
    if (!bin) return null;
    const repo = dirname(dirname(realpathSync(bin)));
    return existsSync(join(repo, "contrib", "guard")) ? repo : null;
  } catch {
    return null;
  }
}

/**
 * Checkout do ginga, dono do guard de segredos (decisão 4 do revamp — o manda
 * só consome o ginga por caminho/CLI, nada é copiado). Sem depender do nome
 * da pasta: `ginga` do PATH, depois a vizinha.
 */
export function defaultGuardDir(pathEnv: string | undefined = process.env.PATH): string {
  return pathGuardDir(pathEnv) ?? siblingGuardDir();
}

/** `GUARD_DIR` do request, `GINGA_HOME`, ou o checkout achado pelo PATH/vizinha. */
export function guardDir(env: Record<string, string | undefined>): string {
  return env.GUARD_DIR ?? env.GINGA_HOME ?? defaultGuardDir("PATH" in env ? env.PATH : process.env.PATH);
}

/**
 * Guard de segredos ligado (PLAN-0033): sessão de lane (GINGA_GUARD_LANE no
 * env) e GINGA_GUARD != "off" (padrão "enforce"). Sem lane o guard é inerte.
 */
export function guardOn(env: Record<string, string | undefined>): boolean {
  return Boolean(env.GINGA_GUARD_LANE) && (env.GINGA_GUARD ?? "enforce") !== "off";
}

export function runtimeEnv(base: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) result[k] = v;
  }
  result.PYTHONDONTWRITEBYTECODE = "1";
  // PLAN-0033 TASK-07: com sessão de lane, carimba o modo e o log do guard
  // (preserva os explícitos do base). Sem GINGA_GUARD_LANE não adiciona nada.
  if (base.GINGA_GUARD_LANE) {
    result.GINGA_GUARD = base.GINGA_GUARD ?? "enforce";
    result.GINGA_GUARD_LOG = base.GINGA_GUARD_LOG ?? `${base.G ?? "."}/handoffs/guard.events.jsonl`;
  }
  return result;
}
