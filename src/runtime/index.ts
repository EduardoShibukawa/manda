import { createAgyRuntime } from "./agy";
import { createClaudeRuntime } from "./claude";
import { createCodexRuntime } from "./codex";
import { createOpenCodeRuntime } from "./opencode";
import { createPiRuntime } from "./pi";
import { defaultSpawn, type SpawnFn, type RuntimeAdapter } from "./port";

/** Nomes de runtime que o port conhece (SPEC 0007). */
export const RUNTIME_NAMES = ["pi", "opencode", "claude", "codex", "agy"] as const;
export type RuntimeName = (typeof RUNTIME_NAMES)[number];

/** Devolve o adapter pelo nome; nome desconhecido é erro de programação. */
export function resolveRuntime(name: string, opts?: { spawn?: SpawnFn }): RuntimeAdapter {
  const spawn = opts?.spawn ?? defaultSpawn;
  switch (name) {
    case "pi":
      return createPiRuntime({ spawn });
    case "opencode":
      return createOpenCodeRuntime({ spawn });
    case "claude":
      return createClaudeRuntime({ spawn });
    case "codex":
      return createCodexRuntime({ spawn });
    case "agy":
      return createAgyRuntime({ spawn });
    default:
      throw new Error(
        `Runtime desconhecido: ${name}. Use ${RUNTIME_NAMES.map((n) => `'${n}'`).join(", ")}.`,
      );
  }
}
