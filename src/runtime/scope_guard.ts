// stub RED (T162): substituído pela implementação da TASK
export type Scope = { touch: string[]; frozen: string[]; root: string };
export type ToolCall = { tool: string; input: Record<string, unknown> };
export type Decision = { allow: true } | { allow: false; rule: "outside_touch" | "frozen" | "bash_refused" | "path_escape"; reason: string };

export function decideToolCall(_call: ToolCall, _scope: Scope): Decision {
  return { allow: true };
}
