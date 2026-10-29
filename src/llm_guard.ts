import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface LlmAgentCheck {
  refused: boolean;
  pid?: number;
  label?: string;
}

function readProcCmdline(procRoot: string, pid: number): string[] {
  try {
    const raw = readFileSync(join(procRoot, String(pid), "cmdline"));
    return raw
      .toString("utf8")
      .split("\0")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function readParentPid(procRoot: string, pid: number): number {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const m = stat.match(/^\d+ \((.*)\) \S+ (\d+)/);
    if (m) return Number(m[2]);
  } catch {}
  return 0;
}

/**
 * Anda a cadeia de ancestrais a partir de startPid (inclusive) e recusa se
 * algum é um agente LLM: `*opencode* run`, `pi`, `claude -p`, `codex exec`
 * (mesma lógica de .ginga/bin/merge-gate.sh; `timeout` com flags/números é pulado).
 */
export function findLlmAgent(startPid: number, procRoot = "/proc"): LlmAgentCheck {
  const seen = new Set<number>();
  let pid = startPid;
  while (pid && pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const cmd = readProcCmdline(procRoot, pid);
    if (cmd.length > 0) {
      let b0 = basename(cmd[0]);
      let i = 1;
      if (b0 === "timeout") {
        while (i < cmd.length && (cmd[i]!.startsWith("-") || /^\d+$/.test(cmd[i]!))) i += 1;
        if (i < cmd.length) {
          b0 = basename(cmd[i]!);
          i += 1;
        }
      }
      const arg = cmd[i] ?? "";
      const refused =
        (b0.includes("opencode") && arg === "run") ||
        b0 === "pi" ||
        (b0 === "claude" && arg === "-p") ||
        (b0 === "codex" && arg === "exec");
      if (refused) {
        return { refused: true, pid, label: b0 };
      }
    }
    pid = readParentPid(procRoot, pid);
  }
  return { refused: false };
}
