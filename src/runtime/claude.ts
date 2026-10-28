import { classifyRunnerFailure, toFailureKind } from "./failure";
import {
  defaultSpawn,
  modelFamily,
  type FailureKind,
  type RunRequest,
  type RunResult,
  type RunnerUsage,
  type RuntimeAdapter,
  type SpawnFn,
} from "./port";

/**
 * Parser do `claude -p --output-format json`.
 *
 * Portado de `parseClaudeOutput` (runners.ts l. 488). Um único objeto JSON com
 * `result`, `is_error`, `total_cost_usd`, `session_id`, `usage` e `modelUsage`.
 * Saída que não é JSON vira `isError: true` (erro em texto puro).
 */
export function parseClaudeOutput(stdout: string): {
  resultText: string;
  isError: boolean;
  costUsd?: number;
  durationMs?: number;
  usage?: RunnerUsage;
  sessionId?: string;
  /** Modelo de maior volume em `modelUsage` (o host reporta mais de um). */
  modelEffective?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { resultText: "", isError: false };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const resultText = parsed.result ?? (parsed.text || trimmed);
    const isError = Boolean(parsed.is_error || parsed.error);
    const costUsd = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined;
    const durationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined;

    let usage: RunnerUsage | undefined;
    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage;
      const inputTokens = Number(u.input_tokens ?? 0);
      const outputTokens = Number(u.output_tokens ?? 0);
      const cacheReadTokens = Number(u.cache_read_input_tokens ?? 0);
      const cacheWriteTokens = Number(u.cache_creation_input_tokens ?? 0);
      const reasoningTokens = 0;
      usage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
      };
    }

    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;

    let modelEffective: string | undefined;
    if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
      let best = -1;
      for (const [id, mu] of Object.entries(parsed.modelUsage as Record<string, any>)) {
        const vol = Number(mu?.inputTokens ?? 0) + Number(mu?.outputTokens ?? 0);
        if (vol > best) {
          best = vol;
          modelEffective = id;
        }
      }
    }

    return { resultText, isError, costUsd, durationMs, usage, sessionId, modelEffective };
  } catch {
    // Fallback: se o Claude Code emitir erro em texto puro.
    return { resultText: trimmed, isError: true };
  }
}

export function createClaudeRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "claude";
  return {
    name: "claude",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      const timeoutMs = req.timeoutMs || 240_000;
      const args = [
        "-p",
        req.prompt,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
      ];
      if (req.model && req.model !== "default") {
        args.push("--model", req.model);
      }

      const raw = await spawnFn([bin, ...args], { cwd: req.worktree, env: req.env, timeoutMs });
      const parsed = parseClaudeOutput(raw.stdout);
      const passed = raw.exitCode === 0 && !parsed.isError && !raw.timedOut;

      let failure: FailureKind | undefined;
      if (!passed) {
        if (raw.timedOut) {
          failure = "timeout";
        } else if (raw.exitCode !== 0) {
          failure = toFailureKind(
            classifyRunnerFailure({ exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr }),
          );
        } else {
          failure = toFailureKind(
            classifyRunnerFailure({ stdout: parsed.resultText, stderr: raw.stderr }),
          );
        }
      }

      return {
        passed,
        failure,
        usage: parsed.usage,
        costUsd: parsed.costUsd,
        stdout: raw.stdout,
        stderr: raw.stderr,
        resultText: parsed.resultText,
        model: parsed.modelEffective ?? req.model,
        sessionId: parsed.sessionId,
      };
    },
  };
}
