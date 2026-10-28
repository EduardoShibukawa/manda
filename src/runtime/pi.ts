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
 * Extrai uso e custo do NDJSON do pi (`--mode json`).
 *
 * Portado de `parsePiRunnerOutput` (runners.ts l. 281) sem depender do
 * `parseEventStream` do bench: só o parsing de `message_end`/`turn_end`
 * (usage, custo, stopReason, errorMessage) e `agent_settled` (aborted).
 */
export function parsePiRunnerOutput(stdout: string): {
  usage?: RunnerUsage;
  costUsd?: number;
  stopReason?: string;
  aborted?: boolean;
  /** Houve `stopReason: "error"` e nenhuma resposta terminou com `stop`. */
  apiError?: boolean;
  /** Última `errorMessage` de um `message_end` (para classificar a falha). */
  errorMessage?: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let costUsd: number | undefined;
  let sawCost = false;
  const stopReasons: Record<string, number> = {};
  let aborted: boolean | undefined;
  let errorMessage: string | undefined;
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;

    if (event.type === "agent_settled") {
      if (typeof event.aborted === "boolean") aborted = event.aborted;
      continue;
    }

    if (
      (event.type === "message_end" || event.type === "turn_end") &&
      event.message?.usage &&
      event.message.role !== "user"
    ) {
      const message = event.message;
      // `message_end` e `turn_end` podem carregar a MESMA mensagem: dedupe
      // pela identidade para não contar tokens/custo 2×.
      const key =
        message.responseId ?? message.response_id ?? message.id ?? message.messageId ?? message.timestamp;
      let isDuplicate = false;
      if (key !== undefined && key !== null) {
        const k = String(key);
        isDuplicate = seen.has(k);
        seen.add(k);
      }

      const u = message.usage;
      if (u && !isDuplicate) {
        const inp = Number(u.input ?? u.input_tokens ?? 0);
        const out = Number(u.output ?? u.output_tokens ?? 0);
        const cr = Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0);
        const cw = Number(u.cacheWrite ?? u.cache_creation_input_tokens ?? 0);
        const reas = Number(u.reasoning ?? u.thinking_tokens ?? 0);
        const tot = Number(u.totalTokens ?? u.total_tokens ?? inp + out + cr + cw + reas);
        inputTokens += inp;
        outputTokens += out;
        cacheReadTokens += cr;
        cacheWriteTokens += cw;
        reasoningTokens += reas;
        totalTokens += tot;

        const costObj = u.cost;
        const reported = costObj ? Number(costObj.total) : Number.NaN;
        if (Number.isFinite(reported)) {
          costUsd = (costUsd ?? 0) + reported;
          sawCost = true;
        }
      }

      const stopReason = message.stopReason ?? message.stop_reason;
      if (typeof stopReason === "string" && stopReason.trim()) {
        if (!isDuplicate || !stopReasons[stopReason]) {
          stopReasons[stopReason] = (stopReasons[stopReason] || 0) + 1;
        }
      }
      if (typeof message.errorMessage === "string" && message.errorMessage) {
        errorMessage = message.errorMessage;
      }
    }
  }

  const reasons = Object.keys(stopReasons);
  const stopReason = reasons.length
    ? reasons.sort((a, b) => stopReasons[b] - stopReasons[a])[0]
    : undefined;
  const apiError = Boolean(stopReasons.error) && !stopReasons.stop;

  const result: {
    usage?: RunnerUsage;
    costUsd?: number;
    stopReason?: string;
    aborted?: boolean;
    apiError?: boolean;
    errorMessage?: string;
  } = { stopReason, aborted, apiError };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  if (sawCost) result.costUsd = costUsd;
  if (totalTokens !== 0 || inputTokens !== 0 || outputTokens !== 0) {
    result.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens:
        totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    };
  }
  return result;
}

export function createPiRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "pi";
  return {
    name: "pi",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      const provider = req.provider || "opencode-go";
      const model = req.model || "qwen3.8-flash";
      const timeoutMs = req.timeoutMs || 180_000;
      const args = ["--no-session", "--mode", "json", "--provider", provider, "--model", model, "-p", req.prompt];
      const raw = await spawnFn([bin, ...args], { cwd: req.worktree, env: req.env, timeoutMs });
      const parsed = parsePiRunnerOutput(raw.stdout);

      // O `pi -p` sai com 0 mesmo quando a API devolve erro (HTTP 400/429):
      // o sinal está no stopReason do NDJSON.
      const passed = raw.exitCode === 0 && parsed.apiError !== true && !raw.timedOut;
      let failure: FailureKind | undefined;
      if (!passed) {
        if (raw.timedOut) {
          failure = "timeout";
        } else if (raw.exitCode !== 0) {
          failure = toFailureKind(
            classifyRunnerFailure({ exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr }),
          );
        } else {
          failure = toFailureKind(classifyRunnerFailure({ stderr: parsed.errorMessage ?? "" }));
        }
      }

      return {
        passed,
        failure,
        usage: parsed.usage,
        costUsd: parsed.costUsd,
        stdout: raw.stdout,
        stderr: raw.stderr,
        resultText: raw.stdout,
        model,
        stopReason: parsed.stopReason,
      };
    },
  };
}
