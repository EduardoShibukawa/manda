import { matchesAny, resolvePath } from "./scope_path";

export type Scope = { touch: string[]; frozen: string[]; root: string };
export type ToolCall = { tool: string; input: Record<string, unknown> };
export type Decision =
  | { allow: true }
  | {
      allow: false;
      rule: "outside_touch" | "frozen" | "bash_refused" | "path_escape";
      reason: string;
    };

function checkBashCommand(command: string): boolean {
  if (command.includes("git add -A")) {
    return true;
  }
  if (command.match(/git\s+add\s+\.\s*$/) || command.includes("git add .")) {
    if (command.match(/git\s+add\s+\.\s*$/) || command === "git add ." || command.startsWith("git add . ") || command.includes("git add .")) {
      // The test checks for "git add ." specifically as a risky pattern
      if (command.includes("git add .")) {
        // be more specific - check for exact pattern
        if (command.match(/git\s+add\s+\.(\s|$)/)) return true;
      }
    }
  }
  if (command.includes("--no-verify")) return true;
  if (command.includes("push --force") || command.match(/push\s+-f\b/)) return true;
  return false;
}

export function decideToolCall(call: ToolCall, scope: Scope): Decision {
  const { tool, input } = call;

  if (tool === "edit" || tool === "write") {
    const path = input?.path;
    if (typeof path !== "string" || !path) {
      return { allow: true };
    }

    const resolved = resolvePath(scope.root, path);
    if (!resolved.ok) {
      return { allow: false, rule: "path_escape", reason: `Path escape detected: ${path}` };
    }

    const rel = resolved.rel;

    if (matchesAny(rel, scope.frozen)) {
      return { allow: false, rule: "frozen", reason: `Path ${path} is frozen` };
    }

    if (!matchesAny(rel, scope.touch)) {
      return {
        allow: false,
        rule: "outside_touch",
        reason: `${path} está fora do touch desta TASK (${scope.touch.join(", ")}). BLOCKED: touch precisa incluir ${path}`,
      };
    }

    return { allow: true };
  }

  if (tool === "bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    if (checkBashCommand(command)) {
      return { allow: false, rule: "bash_refused", reason: `Command refused: ${command}` };
    }
    return { allow: true };
  }

  return { allow: true };
}
