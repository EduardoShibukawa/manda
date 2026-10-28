import { createAgyRuntime } from "./agy";
import { createClaudeRuntime } from "./claude";
import { createCodexRuntime } from "./codex";
import { createOpenCodeRuntime } from "./opencode";
import { createPiRuntime } from "./pi";
import type { RuntimeAdapter } from "./port";

/** Nomes de runtime que o port conhece (SPEC 0007). */
export const RUNTIME_NAMES = ["pi", "opencode", "claude", "codex", "agy"] as const;
export type RuntimeName = (typeof RUNTIME_NAMES)[number];

/** Devolve o adapter pelo nome; nome desconhecido é erro de programação. */
export function resolveRuntime(name: string): RuntimeAdapter {
  switch (name) {
    case "pi":
      return createPiRuntime();
    case "opencode":
      return createOpenCodeRuntime();
    case "claude":
      return createClaudeRuntime();
    case "codex":
      return createCodexRuntime();
    case "agy":
      return createAgyRuntime();
    default:
      throw new Error(
        `Runtime desconhecido: ${name}. Use ${RUNTIME_NAMES.map((n) => `'${n}'`).join(", ")}.`,
      );
  }
}
