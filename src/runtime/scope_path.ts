// stub RED (T163): substituído pela implementação da TASK
export type ResolvedPath = { ok: true; rel: string } | { ok: false; rule: "path_escape" };

export function resolvePath(_root: string, p: string): ResolvedPath {
  return { ok: true, rel: String(p) };
}

export function matchesAny(_rel: string, _patterns: string[]): boolean {
  return false;
}
