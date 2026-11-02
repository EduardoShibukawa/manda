import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { guardDir, guardOn } from "./env";
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

/**
 * Extrai o texto (`content[].text`) da ÚLTIMA `message_end` com `role: "assistant"`
 * do NDJSON do pi (`--mode json`). O stdout cru é NDJSON com o texto JSON-escapado,
 * o que impede o `manda plan` (`^=== FILE: ... ===$`) de achar os blocos do Planner.
 * Sem nenhuma mensagem do assistente, devolve `undefined` (quem chama decide o fallback).
 */
export function extractPiAssistantText(stdout: string): string | undefined {
  let text: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== "message_end") continue;
    if (event.message?.role !== "assistant") continue;
    const content = event.message.content;
    if (!Array.isArray(content)) continue;
    const parts = content
      .filter(
        (part: any) =>
          part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
      )
      .map((part: any) => part.text as string);
    text = parts.join("");
  }
  return text;
}

const SCOPE_GUARD_EXTENSION = resolve(import.meta.dir, "pi_scope_guard.ts");

function parseJsonStringList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === "string" && item.length > 0)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** `[routing].scope_guard` só desliga quando explicitamente vale `false`. */
function scopeGuardEnabled(env: Record<string, string>): boolean {
  const root = env.G;
  if (!root) return true;
  const configPath = join(root, ".ginga", "project.toml");
  if (!existsSync(configPath)) return true;
  try {
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
      routing?: { scope_guard?: unknown };
    };
    return config.routing?.scope_guard !== false;
  } catch {
    return true;
  }
}

/** Escopo declarado pela TASK; lista vazia ou inválida mantém o runtime legado. */
function taskScope(env: Record<string, string>): { touch: string[]; frozen: string[] } | undefined {
  const touch = parseJsonStringList(env.MANDA_TASK_TOUCH);
  if (!touch || touch.length === 0) return undefined;
  const frozen =
    env.MANDA_TASK_FROZEN === undefined ? [] : parseJsonStringList(env.MANDA_TASK_FROZEN);
  if (!frozen) return undefined;
  return { touch, frozen };
}

export function createPiRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "pi";
  return {
    name: "pi",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      // Falha fechada (INTENT-0008): sem rota explícita o `pi` não é spawnado.
      // O `pickRuntime` de run.ts já resolve a rota; o adapter só recebe
      // provider/modelo explícitos, de [runtimes] no project.toml ou do request.
      if (!req.provider || !req.model) {
        const msg =
          "[runtimes] rota ausente para o pi: provider e modelo são obrigatórios; configure a rota em [runtimes] no project.toml ou passe provider/model no request.";
        return {
          passed: false,
          failure: "infra",
          stdout: "",
          stderr: msg,
          resultText: msg,
        };
      }
      const provider = req.provider;
      const model = req.model;
      const timeoutMs = req.timeoutMs || 180_000;
      const args = ["--no-session", "--mode", "json", "--provider", provider, "--model", model];
      // Guard de segredos (PLAN-0033 TASK-07), falha fechada: guard ligado e
      // extensão ausente → a tentativa NÃO é spawnada (guard_missing).
      const genv = req.env ?? {};
      if (guardOn(genv)) {
        const guardExt = join(guardDir(genv), "contrib", "guard", "pi.ts");
        if (!existsSync(guardExt)) {
          const msg = `[guard] ausente em ${guardExt} com guard ligado (GINGA_GUARD_LANE=${genv.GINGA_GUARD_LANE}): tentativa não spawnada (guard_missing)`;
          return {
            passed: false,
            failure: "guard_missing" as FailureKind,
            stdout: "",
            stderr: msg,
            resultText: msg,
          };
        }
        args.push("-e", guardExt);
      }
      // Guarda de escopo (PLAN-0034): só liga quando a TASK declara touch.
      // A extensão é do próprio manda e recebe o escopo derivado do frontmatter.
      const scope = scopeGuardEnabled(genv) ? taskScope(genv) : undefined;
      let spawnEnv = req.env;
      if (scope) {
        args.push("-e", SCOPE_GUARD_EXTENSION);
        spawnEnv = {
          ...genv,
          MANDA_SCOPE_TOUCH: JSON.stringify(scope.touch),
          MANDA_SCOPE_FROZEN: JSON.stringify(scope.frozen),
          MANDA_SCOPE_ROOT: req.worktree,
        };
      }
      args.push("-p", req.prompt);
      const raw = await spawnFn([bin, ...args], {
        cwd: req.worktree,
        env: spawnEnv,
        timeoutMs,
        onPid: req.onPid,
        logPath: req.logPath,
      });
      const parsed = parsePiRunnerOutput(raw.stdout);
      // `resultText` é o texto do assistente (blocos `=== FILE: ===` legíveis ao
      // `manda plan`); sem mensagem do assistente, cai no stdout cru.
      const assistantText = extractPiAssistantText(raw.stdout);

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
        resultText: assistantText ?? raw.stdout,
        model,
        stopReason: parsed.stopReason,
      };
    },
  };
}
