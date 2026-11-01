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

/* ------------------------------------------------------------------ *
 * Contrato de papéis Codex (SPEC 0040 §5.1)
 * ------------------------------------------------------------------ */

/** Papéis em que a lane Codex é permitida. `worker` é proibido por construção. */
export const CODEX_ALLOWED_ROLES = ["planner", "reviewer", "judge"] as const;
export type CodexAllowedRole = (typeof CODEX_ALLOWED_ROLES)[number];

export type CodexRefusalKind = "disabled" | "role_forbidden" | "prompt_too_large";

/** Mensagem canônica da recusa de worker (cita o overhead medido). */
export const CODEX_WORKER_REFUSAL_MESSAGE: string =
  "Codex não é worker: overhead medido de ~11,7k input tokens (lean, resposta trivial) e ~27,8k (escrita minúscula) por invocação, pago de novo a cada retry, sobre cota de assinatura finita. Use pi/opencode/claude-code para tasks atômicas.";

/**
 * Contrato puro de papéis, sem I/O.
 * Ordem de avaliação: disabled → role_forbidden → prompt_too_large.
 */
export function checkCodexContract(input: {
  enabled: boolean;
  role?: string;
  promptChars: number;
  maxPromptTokens: number;
}): { ok: true } | { ok: false; kind: CodexRefusalKind; message: string } {
  if (!input.enabled) {
    return {
      ok: false,
      kind: "disabled",
      message: "Codex desabilitado: defina PI_CODEX_ENABLED=1 para consumir a cota de assinatura.",
    };
  }

  if (!input.role || !(CODEX_ALLOWED_ROLES as readonly string[]).includes(input.role)) {
    const roleLabel = input.role ?? "ausente";
    if (roleLabel === "worker") {
      return { ok: false, kind: "role_forbidden", message: CODEX_WORKER_REFUSAL_MESSAGE };
    }
    return {
      ok: false,
      kind: "role_forbidden",
      message: `Papel "${roleLabel}" não é permitido para Codex. Papéis permitidos: ${CODEX_ALLOWED_ROLES.join(", ")}.`,
    };
  }

  const estimatedTokens = Math.ceil(input.promptChars / 4);
  if (estimatedTokens > input.maxPromptTokens) {
    return {
      ok: false,
      kind: "prompt_too_large",
      message: `Prompt estimado em ${estimatedTokens} tokens excede o teto de ${input.maxPromptTokens} (PI_CODEX_MAX_PROMPT_TOKENS).`,
    };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Parser do `codex exec --json`
 * ------------------------------------------------------------------ */

/**
 * Portado de `parseCodexOutput` (runners.ts l. 729).
 *
 * Eventos relevantes: `thread.started`, `item.completed` (agent_message,
 * command_execution), `turn.completed.usage` e `turn.failed`/`error`.
 * O Codex não reporta custo em dólar: a lane é de assinatura, então o custo
 * marginal é `0` — nunca um preço inventado.
 */
export function parseCodexOutput(stdout: string): {
  resultText: string;
  isError: boolean;
  usage?: RunnerUsage;
  threadId?: string;
  toolCalls: Record<string, number>;
  errorKind?: "invalid_jsonl" | "truncated_stream" | "turn_failed";
  invalidLines: number;
  commands: Array<{ command: string; exitCode?: number }>;
  completed: boolean;
} {
  const usage: RunnerUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  const toolCalls: Record<string, number> = {};
  const commands: Array<{ command: string; exitCode?: number }> = [];
  let resultText = "";
  let isError = false;
  let threadId: string | undefined;
  let sawUsage = false;
  let invalidLines = 0;
  let completed = false;
  let failed = false;
  let lastJsonLineInvalid = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
      lastJsonLineInvalid = false;
    } catch {
      invalidLines++;
      lastJsonLineInvalid = true;
      continue;
    }

    if (event.type === "turn.completed") completed = true;
    if (event.type === "error" || event.type === "turn.failed") {
      failed = true;
      isError = true;
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }

    if (event.type === "item.completed" && event.item) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        resultText = item.text;
      }
      if (item.type === "command_execution") {
        toolCalls.command_execution = (toolCalls.command_execution || 0) + 1;
        commands.push({ command: String(item.command ?? ""), exitCode: item.exit_code });
      }
      if (item.type === "file_change") {
        toolCalls.file_change = (toolCalls.file_change || 0) + 1;
      }
    }

    if (event.type === "turn.completed" && event.usage) {
      const u = event.usage;
      usage.inputTokens += Number(u.input_tokens ?? 0);
      usage.outputTokens += Number(u.output_tokens ?? 0);
      usage.cacheReadTokens += Number(u.cached_input_tokens ?? 0);
      usage.cacheWriteTokens += Number(u.cache_write_input_tokens ?? 0);
      usage.reasoningTokens += Number(u.reasoning_output_tokens ?? 0);
      sawUsage = true;
    }
  }

  // O Codex reporta input_tokens já incluindo os tokens cacheados: somar o
  // cache de novo inflaria o total.
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;

  let errorKind: "invalid_jsonl" | "truncated_stream" | "turn_failed" | undefined;
  if (failed) {
    errorKind = "turn_failed";
  } else if (!completed && stdout.trim() !== "") {
    errorKind = lastJsonLineInvalid ? "invalid_jsonl" : "truncated_stream";
  }
  if (errorKind) isError = true;

  return {
    resultText: resultText.trim(),
    isError,
    usage: sawUsage ? usage : undefined,
    threadId,
    toolCalls,
    errorKind,
    invalidLines,
    commands,
    completed,
  };
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

/** Resultado do adapter Codex: carrega o motivo da recusa, se houver. */
export interface CodexRunResult extends RunResult {
  refusal?: CodexRefusalKind;
}

export const DEFAULT_CODEX_MAX_PROMPT_TOKENS = 60_000;

function codexEnabled(env?: Record<string, string>): boolean {
  return (env?.PI_CODEX_ENABLED ?? process.env.PI_CODEX_ENABLED) === "1";
}

function maxPromptTokens(env?: Record<string, string>): number {
  const raw = env?.PI_CODEX_MAX_PROMPT_TOKENS ?? process.env.PI_CODEX_MAX_PROMPT_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CODEX_MAX_PROMPT_TOKENS;
}

/** Recusa sem subir processo: o contrato é checado antes do spawn. */
function refusal(kind: CodexRefusalKind, message: string): CodexRunResult {
  return { passed: false, failure: "infra", stdout: "", refusal: kind, resultText: message };
}

export function createCodexRuntime(opts: { spawn?: SpawnFn; bin?: string } = {}): RuntimeAdapter {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const bin = opts.bin ?? "codex";
  return {
    name: "codex",
    family: modelFamily,
    async run(req: RunRequest): Promise<RunResult> {
      const contract = checkCodexContract({
        enabled: codexEnabled(req.env),
        role: req.role,
        promptChars: req.prompt.length,
        maxPromptTokens: maxPromptTokens(req.env),
      });
      if (!contract.ok) return refusal(contract.kind, contract.message);

      const model = req.model || "gpt-6-luna";
      const timeoutMs = req.timeoutMs || 240_000;
      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        req.worktree,
        "-m",
        model,
        req.prompt,
      ];

      const raw = await spawnFn([bin, ...args], {
        cwd: req.worktree,
        env: req.env,
        timeoutMs,
        onPid: req.onPid,
        logPath: req.logPath,
      });
      const parsed = parseCodexOutput(raw.stdout);
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
          failure = "infra";
        }
      }

      const result: CodexRunResult = {
        passed,
        failure,
        usage: parsed.usage,
        // Cota de assinatura: o custo marginal é zero, não um preço de API.
        costUsd: 0,
        stdout: raw.stdout,
        stderr: raw.stderr,
        resultText: parsed.resultText,
        model,
        sessionId: parsed.threadId,
      };
      return result;
    },
  };
}
