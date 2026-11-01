/**
 * Variável de ambiente e stdin padrão para todos os runtimes (PLAN-0029 TASK-05).
 * Previne `scope_drift` por `__pycache__` (PYTHONDONTWRITEBYTECODE=1) e
 * entrada acidental no stdin (SPAWN_STDIN="ignore").
 */
import { join } from "node:path";

export const SPAWN_STDIN = "ignore" as const;

/**
 * Checkout da main do `ginga`: irmão do repo manda (decisão 4 do revamp —
 * o manda só consome o ginga por caminho/CLI, nada é copiado).
 */
export function defaultGuardDir(): string {
  return join(import.meta.dir, "..", "..", "..", "ginga");
}

/** `GUARD_DIR` do request ou o checkout da main do ginga (irmão do repo). */
export function guardDir(env: Record<string, string | undefined>): string {
  return env.GUARD_DIR ?? defaultGuardDir();
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
