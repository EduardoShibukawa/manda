/**
 * Variável de ambiente e stdin padrão para todos os runtimes (PLAN-0029 TASK-05).
 * Previne `scope_drift` por `__pycache__` (PYTHONDONTWRITEBYTECODE=1) e
 * entrada acidental no stdin (SPAWN_STDIN="ignore").
 */
export const SPAWN_STDIN = "ignore" as const;

export function runtimeEnv(base: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) result[k] = v;
  }
  result.PYTHONDONTWRITEBYTECODE = "1";
  return result;
}
