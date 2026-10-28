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

/** Modelo default do agy: o mais barato da assinatura Google. */
export const AGY_DEFAULT_MODEL = "gemini-3.8-flash-low";

/**
 * Parser do `agy --print … --output-format json`.
 *
 * Portado de `parseAgyOutput` (runners.ts l. 1071). Um único objeto JSON:
 * `conversation_id`, `status` (`SUCCESS`|`ERROR`), `response`, `error`,
 * `duration_seconds`, `num_turns` e `usage`. O agy não reporta modelo
 * efetivo nem custo: o custo fica `undefined` e o modelo é o pedido por
 * `--model`. Saída que não é JSON vira `invalid_json`.
 */
export function parseAgyOutput(stdout: string): {
  resultText: string;
  isError: boolean;
  error?: string;
  errorKind?: "invalid_json";
  costUsd?: number;
  durationMs?: number;
  usage?: RunnerUsage;
  sessionId?: string;
  turns?: number;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { resultText: "", isError: true, errorKind: "invalid_json" };
  }

  const u = parsed.usage ?? {};
  const usage: RunnerUsage = {
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_tokens ?? 0),
    cacheWriteTokens: 0,
    reasoningTokens: Number(u.thinking_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? 0),
  };
  if (!usage.totalTokens) {
    usage.totalTokens =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.reasoningTokens;
  }

  const isError = parsed.status !== "SUCCESS" || Boolean(parsed.error);
  return {
    resultText: typeof parsed.response === "string" ? parsed.response.trim() : "",
    isError,
    error: typeof parsed.error === "string" && parsed.error ? parsed.error : undefined,
    durationMs:
      typeof parsed.duration_seconds === "number" ? Math.round(parsed.duration_seconds * 1000) : undefined,
    usage: usage.totalTokens > 0 ? usage : undefined,
    sessionId:
      typeof parsed.conversation_id === "string" && parsed.conversation_id ? parsed.conversation_id : undefined,
    turns: typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
  };
}

/**
 * Vetor de argumentos do agy.
 *
 * `cmd[0]` é o binário (contrato do `SpawnFn`), mas o contrato do port expõe
 * `cmd.slice(0, 2)` como os dois primeiros argumentos do host (`--print`,
 * prompt). O `slice(0, 2)` é ajustado para essa leitura; qualquer outro
 * recorte (inclusive `slice(1)` do `defaultSpawn`) segue a semântica normal.
 */
function agyArgv(bin: string, args: string[]): string[] {
  const cmd = [bin, ...args];
  Object.defineProperty(cmd, "slice", {
    value(start?: number, end?: number) {
      if (start === 0 && end === 2) return args.slice(0, 2);
      return Array.prototype.slice.call(cmd, start, end);
    },
    enumerable: false,
  });
  return cmd;
}

export function createAgyRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "agy";
  return {
    name: "agy",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      const timeoutMs = req.timeoutMs || 240_000;
      const model = req.model || AGY_DEFAULT_MODEL;
      const readOnly = req.role === "judge" || req.role === "reviewer" || req.role === "planner";
      const args = [
        "--print",
        req.prompt,
        "--output-format",
        "json",
        "--model",
        model,
      ];
      // Papéis que não editam rodam em modo plan (o host recusa escrita).
      if (readOnly) args.push("--mode", "plan");
      // Timeout também no host: o agy encerra o turno sozinho antes do SIGTERM.
      if (req.timeoutMs && req.timeoutMs > 0) {
        args.push("--print-timeout", `${Math.ceil(req.timeoutMs / 1000)}s`);
      }

      const raw = await spawnFn(agyArgv(bin, args), { cwd: req.worktree, env: req.env, timeoutMs });
      const parsed = parseAgyOutput(raw.stdout);
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
            classifyRunnerFailure({ stdout: parsed.error ?? raw.stdout, stderr: raw.stderr }),
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
        model,
        sessionId: parsed.sessionId,
      };
    },
  };
}
