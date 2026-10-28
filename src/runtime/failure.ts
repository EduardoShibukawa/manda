import type { FailureKind } from "./port";

/**
 * Classifica a falha de uma execução real no vocabulário do probe
 * (SPEC 0030). Portado de `pi-harness/.pi/extensions/runners.ts`.
 */
export function classifyRunnerFailure(res: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): "unauthorized" | "not_found" | "quota_exhausted" | "server_error" | "timeout" | "unknown" {
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.toLowerCase();
  if (!text.trim()) return "unknown";
  if (/free-limit|freeusage|free usage limit|rate limit|429|quota/.test(text)) {
    return "quota_exhausted";
  }
  if (/401|403|unauthorized|invalid credential|not permitted|access denied/.test(text)) {
    return "unauthorized";
  }
  if (/404|model not found|no such model|unknown model|not supported when using codex/.test(text)) {
    return "not_found";
  }
  if (/timeout|timed out|etimedout/.test(text)) {
    return "timeout";
  }
  if (/\b50[0234]\b|server_error|internal error|bad gateway|service unavailable/.test(text)) {
    return "server_error";
  }
  return "unknown";
}

/**
 * Mapeia a classe do probe para o vocabulário de falha do runtime port.
 * Só `timeout` e `quota_exhausted` têm correspondência direta; o resto
 * (unauthorized, not_found, server_error, unknown) vira `infra`.
 */
export function toFailureKind(cls: string): FailureKind {
  if (cls === "timeout") return "timeout";
  if (cls === "quota_exhausted") return "quota_exhausted";
  return "infra";
}
