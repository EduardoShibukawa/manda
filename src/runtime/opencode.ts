import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * Parser do `opencode run --format json`.
 *
 * O OpenCode emite NDJSON com `step_start`, `text`, `tool_use`, `step_finish`.
 * O `step_finish` traz `cost` e `tokens` por passo; o último passo pode não
 * emitir `step_finish` — nesse caso o uso fica subestimado e o custo é
 * `undefined` (nunca inventamos dólar).
 */
export function parseOpenCodeOutput(stdout: string): {
  resultText: string;
  isError: boolean;
  costUsd?: number;
  usage?: RunnerUsage;
  sessionId?: string;
  /** Mensagem do evento `error` (para classificar a falha). */
  errorMessage?: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let resultText = "";
  let isError = false;
  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let cost = 0;
  let sawCost = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    if (event.type === "error") {
      isError = true;
      const msg = event.error?.data?.message ?? event.error?.message ?? event.error?.name;
      if (typeof msg === "string" && msg) errorMessage = msg;
    }

    if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
      resultText = event.part.text;
    }

    if (event.type === "step_finish" && event.part) {
      if (typeof event.part.cost === "number") {
        cost += event.part.cost;
        sawCost = true;
      }
      const tokens = event.part.tokens;
      if (tokens) {
        inputTokens += Number(tokens.input ?? 0);
        outputTokens += Number(tokens.output ?? 0);
        reasoningTokens += Number(tokens.reasoning ?? 0);
        cacheReadTokens += Number(tokens.cache?.read ?? 0);
        cacheWriteTokens += Number(tokens.cache?.write ?? 0);
      }
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
  const result: {
    resultText: string;
    isError: boolean;
    costUsd?: number;
    usage?: RunnerUsage;
    sessionId?: string;
    errorMessage?: string;
  } = { resultText: resultText.trim(), isError, sessionId };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  if (sawCost) result.costUsd = Number(cost.toFixed(6));
  if (totalTokens > 0) {
    result.usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens };
  }
  return result;
}

export function createOpenCodeRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "opencode";
  return {
    name: "opencode",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      const provider = req.provider || "opencode";
      const model = req.model || "deepseek-v4.1-flash-free";
      const timeoutMs = req.timeoutMs || 180_000;
      const modelRef = model.includes("/") ? model : `${provider}/${model}`;
      const args = ["run", "--standalone", "--auto", "--format", "json", "-m", modelRef, req.prompt];
      // Guard de segredos (PLAN-0033 TASK-07), falha fechada: guard ligado e
      // plugin ausente → a tentativa NÃO é spawnada (guard_missing); ligado e
      // presente → OPENCODE_CONFIG_DIR aponta para o config dir do guard.
      const genv = req.env ?? {};
      let env = req.env;
      if (guardOn(genv)) {
        const guardPlugin = join(guardDir(genv), "contrib", "guard", "opencode.ts");
        if (!existsSync(guardPlugin)) {
          const msg = `[guard] ausente em ${guardPlugin} com guard ligado (GINGA_GUARD_LANE=${genv.GINGA_GUARD_LANE}): tentativa não spawnada (guard_missing)`;
          return {
            passed: false,
            failure: "guard_missing" as FailureKind,
            stdout: "",
            stderr: msg,
            resultText: msg,
          };
        }
        env = { ...genv, OPENCODE_CONFIG_DIR: join(guardDir(genv), "contrib", "guard", "opencode-config") };
      }
      const raw = await spawnFn([bin, ...args], {
        cwd: req.worktree,
        env,
        timeoutMs,
        onPid: req.onPid,
        logPath: req.logPath,
      });
      const parsed = parseOpenCodeOutput(raw.stdout);

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
        resultText: parsed.resultText,
        model,
        sessionId: parsed.sessionId,
      };
    },
  };
}
