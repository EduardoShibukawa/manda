// stub RED (T165): substituído pela implementação da TASK
import type { MandaEvent } from "../events";

export function emitScopeBlock(_o: { task?: string; tool: string; path: string; rule: string }): MandaEvent {
  return { v: 0, ts: "", source: "", kind: "stub", id: "", data: {} };
}

export function emitScopeGuardError(_o: { task?: string; message: string }): MandaEvent {
  return { v: 0, ts: "", source: "", kind: "stub", id: "", data: {} };
}

export function countByRule(_events: MandaEvent[]): Record<string, number> {
  return {};
}
