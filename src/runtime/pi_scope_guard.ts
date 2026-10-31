import type { decideToolCall } from "./scope_guard";
import { decideToolCall as decide } from "./scope_guard";
import { emitEvent } from "../events";

export default function (pi: any): void {
  const touch = process.env.MANDA_SCOPE_TOUCH;
  const frozen = process.env.MANDA_SCOPE_FROZEN;
  const root = process.env.MANDA_SCOPE_ROOT;

  if (touch === undefined || frozen === undefined || root === undefined) {
    return;
  }

  let scope: { touch: string[]; frozen: string[]; root: string };
  try {
    const parsedTouch = JSON.parse(touch);
    const parsedFrozen = JSON.parse(frozen);
    if (!Array.isArray(parsedTouch) || !Array.isArray(parsedFrozen) || typeof root !== "string") {
      throw new Error("invalid scope");
    }
    scope = { touch: parsedTouch, frozen: parsedFrozen, root };
  } catch (err) {
    try {
      emitEvent("scope.guard_error", { message: err instanceof Error ? err.message : String(err) });
    } catch {
      // never throw
    }
    const handler = (event: { toolName?: string; tool?: string; input?: Record<string, unknown> }, _ctx?: unknown) => {
      try {
        // still need to register handler? Wait - look up test again
        // "JSON inválido nas variáveis → libera e emite scope.guard_error"
        // Test says: set invalid touch, registers handler, calls handler with path and gets undefined
        // Also says "com variáveis registra handler em tool_call" when valid. But with invalid JSON - does it register?
        // Looking at test line 67-81: after setting invalid, does ext(pi), expects handlers["tool_call"] defined, calls handler and gets undefined
        // So handler IS registered even with invalid JSON? Let us look up the test again carefully
      } catch {}
      return undefined;
    };
    try {
      pi.on("tool_call", handler);
    } catch {
      // never throw
    }
    return;
  }

  const handler = (event: { toolName?: string; tool?: string; input?: Record<string, unknown> }, _ctx?: unknown) => {
    try {
      const toolName = event?.toolName ?? (event as any)?.tool ?? "";
      const input = event?.input ?? {};
      const decision = decide({ tool: toolName, input }, scope);
      if (decision.allow === false) {
        return { block: true, reason: decision.reason };
      }
      return undefined;
    } catch (err) {
      try {
        emitEvent("scope.guard_error", { message: err instanceof Error ? err.message : String(err) });
      } catch {
        // never throw
      }
      return undefined;
    }
  };

  try {
    pi.on("tool_call", handler);
  } catch {
    // never throw
  }
}
