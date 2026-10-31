/* STUB — TASK-05 RED: runtimeEnv não injeta PYTHONDONTWRITEBYTECODE ainda. */

export const SPAWN_STDIN = "ignore" as const;

export function runtimeEnv(base: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}
