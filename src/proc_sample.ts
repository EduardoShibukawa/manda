import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunObs } from "./run_state";

/**
 * Amostragem real de uma tentativa viva (PLAN-0029 TASK-12).
 *
 * A vigia ao vivo (`watchAttempt`) precisa de um `RunObs` por amostragem: cpu
 * do `/proc/<pid>/stat`, mudança de arquivo pelo `git status` da worktree e
 * bytes de stream pelo tamanho do log/eventos. Pid morto lança — quem vigia
 * desiste e deixa o fluxo principal (`run.ts`) decidir o resultado.
 */

/** `jiffies` por segundo do kernel (Linux usa 100 quase sempre). */
const CLK_TCK = 100;

/** Alvo da amostragem: o processo da tentativa e os arquivos que a cercam. */
export interface ProcSampleTarget {
  pid: number;
  /** Worktree da tentativa: `git status` aqui diz se houve mudança de arquivo. */
  worktree: string;
  /** Log/eventos da tentativa: tamanho vira `stream_bytes`, mtime vira evento. */
  streamPath?: string;
  /** Início da tentativa (epoch ms): sem evento anterior, ele é a referência. */
  startedAt: number;
}

/** utime+stime (jiffies) de `/proc/<pid>/stat`; lança se o pid não existe. */
export function procCpuTicks(pid: number): number {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  // `comm` pode conter espaços/parênteses: os campos numéricos vêm depois do último `)`.
  const close = raw.lastIndexOf(")");
  if (close === -1) throw new Error(`/proc/${pid}/stat ilegível`);
  const fields = raw.slice(close + 2).split(/\s+/);
  // campo 14 (utime) e 15 (stime): índice = campo - 3.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
    throw new Error(`/proc/${pid}/stat sem utime/stime`);
  }
  return utime + stime;
}

function bytesOf(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function mtimeMs(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** A worktree tem mudança não commitada? Git ausente/erro = "não sei" (false). */
export function worktreeChanged(worktree: string): boolean {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return res.exitCode === 0 && res.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Amostrador com estado: guarda a leitura anterior de cpu para devolver o
 * delta em `cpu_pct`. O pid morto lança — a tentativa acabou e o fluxo
 * principal é quem fecha a história dela.
 */
export function procSampler(target: ProcSampleTarget): () => Promise<RunObs> {
  let lastTicks: number | null = null;
  let lastAt = 0;
  return async (): Promise<RunObs> => {
    const ticks = procCpuTicks(target.pid);
    const now = Date.now();
    let cpuPct = 0;
    if (lastTicks !== null) {
      const deltaSec = (now - lastAt) / 1000;
      if (deltaSec > 0) {
        cpuPct = Math.max(0, Math.min(100, ((ticks - lastTicks) / CLK_TCK / deltaSec) * 100));
      }
    }
    lastTicks = ticks;
    lastAt = now;

    const streamBytes = bytesOf(target.streamPath);
    // O último evento não pode ser mais antigo que o início da tentativa.
    const lastEventMs = Math.max(mtimeMs(target.streamPath), target.startedAt);
    const sinceLastEventS = Math.max(0, (now - lastEventMs) / 1000);

    return {
      since_last_event_s: sinceLastEventS,
      stream_bytes: streamBytes,
      cpu_pct: cpuPct,
      files_changed: worktreeChanged(target.worktree),
      // O probe é passo separado da vigia (só quando `travado`): aqui não sabemos.
      probe_ok: false,
      exit: null,
      stderr_tail: "",
    };
  };
}

/** Config da vigia em `[routing]` do project.toml (default 30/15 min). */
export function watchCfg(root: string): { patience_min: number; no_progress_min: number } {
  const dflt = { patience_min: 30, no_progress_min: 15 };
  try {
    const path = join(root, ".ginga", "project.toml");
    if (!existsSync(path)) return dflt;
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const routing = (parsed.routing ?? {}) as Record<string, unknown>;
    const num = (raw: unknown, fallback: number): number =>
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
    return {
      patience_min: num(routing.patience_min, dflt.patience_min),
      no_progress_min: num(routing.no_progress_min, dflt.no_progress_min),
    };
  } catch {
    return dflt;
  }
}
