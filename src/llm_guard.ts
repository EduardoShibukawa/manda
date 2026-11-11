import { existsSync, readFileSync } from "node:fs";
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

export type PsReader = (pid: number) => { ppid: number; command: string } | null;

/** T912: um processo pelo `ps` (macOS não tem /proc). */
const realPs: PsReader = (pid) => {
  try {
    const r = Bun.spawnSync(["ps", "-o", "ppid=,command=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.toString().split("\n")[0] ?? "");
    return m ? { ppid: Number(m[1]), command: m[2]!.trim() } : null;
  } catch {
    return null;
  }
};

/**
 * Anda a cadeia de ancestrais a partir de startPid (inclusive) e recusa se
 * algum é um agente LLM: `*opencode* run`, `pi`, `claude -p`, `codex exec`
 * (mesma lógica de .ginga/bin/merge-gate.sh; `timeout` com flags/números é pulado).
 */
export function findLlmAgent(startPid: number, procRoot = "/proc", ps: PsReader = realPs): LlmAgentCheck {
  const seen = new Set<number>();
  let pid = startPid;
  // T912: sem /proc (macOS) a cadeia vem do `ps`; a regra de recusa é a mesma.
  const viaPs = !existsSync(procRoot);
  while (pid && pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const node = viaPs ? ps(pid) : null;
    const cmd = viaPs ? (node?.command ?? "").split(/\s+/).filter(Boolean) : readProcCmdline(procRoot, pid);
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
    pid = viaPs ? (node?.ppid ?? 0) : readParentPid(procRoot, pid);
  }
  return { refused: false };
}
