import { spawn } from "node:child_process";

/** Vocabulário de falha do runtime port (SPEC 0007). */
export type FailureKind = "done_when" | "quota_exhausted" | "timeout" | "infra" | "judge";

export const FAILURES: readonly FailureKind[] = [
  "done_when",
  "quota_exhausted",
  "timeout",
  "infra",
  "judge",
];

/** Uso de tokens normalizado — comum a pi, Claude Code, OpenCode e Codex. */
export interface RunnerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface RunRequest {
  worktree: string;
  prompt: string;
  model?: string;
  provider?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  role?: string;
  /**
   * Expoe o pid do processo filho (PLAN-0029 TASK-12): a vigia ao vivo
   * amostra `/proc/<pid>` e mata travados pelo pid. Opcional — adapter sem
   * spawn rastreável simplesmente nunca chama.
   */
  onPid?: (pid: number) => void;
}

export interface RunResult {
  passed: boolean;
  failure?: FailureKind;
  usage?: RunnerUsage;
  costUsd?: number;
  stdout: string;
  stderr?: string;
  resultText?: string;
  model?: string;
  sessionId?: string;
  stopReason?: string;
}

/** Spawn injetável: os testes gravam stdout/stderr sem subir processo real. */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; onPid?: (pid: number) => void },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export interface RuntimeAdapter {
  readonly name: string;
  family(model: string): string;
  run(req: RunRequest): Promise<RunResult>;
}

const MODEL_FAMILY_PREFIXES: [string, string][] = [
  ["claude", "claude"],
  ["gemini", "gemini"],
  ["gpt", "gpt"],
  ["kimi", "kimi"],
  ["deepseek", "deepseek"],
  ["minimax", "minimax"],
  ["longcat", "longcat"],
  ["glm", "glm"],
  ["mimo", "mimo"],
  ["ornith", "ornith"],
  ["qwen", "qwen"],
];

/** Família do modelo (ex.: "qwen3.8-flash" → "qwen"). Vazia → "unknown". */
export function modelFamily(model: string): string {
  const normalized = (model || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  const head = normalized.split(/[.-]/)[0];
  for (const [prefix, family] of MODEL_FAMILY_PREFIXES) {
    if (head === prefix || head.startsWith(prefix)) return family;
  }
  return head || "unknown";
}

/** Spawn real (portado de `pi-harness/src/router/probe.ts` `defaultSpawn`). */
export const defaultSpawn: SpawnFn = (cmd, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    // A vigia ao vivo (PLAN-0029 TASK-12) acompanha o filho pelo pid.
    opts.onPid?.(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
  });
