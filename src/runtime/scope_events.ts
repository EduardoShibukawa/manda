import { emitEvent, type EventScope, type MandaEvent } from "../events";

export function emitScopeBlock(o: {
  task?: string;
  tool: string;
  path: string;
  rule: string;
}): MandaEvent {
  const scope: EventScope = {};
  if (typeof o.task === "string" && o.task.trim()) {
    scope.task = o.task;
  }
  const data: Record<string, unknown> = {
    task: o.task,
    tool: o.tool,
    path: o.path,
    rule: o.rule,
  };
  // Keep shape exactly as passed but ensure task is present if provided
  if (o.task === undefined) {
    delete (data as any).task;
  } else {
    data.task = o.task;
  }
  return emitEvent("scope.block", data, scope);
}

export function emitScopeGuardError(o: { task?: string; message: string }): MandaEvent {
  const scope: EventScope = {};
  if (typeof o.task === "string" && o.task.trim()) {
    scope.task = o.task;
  }
  const data: Record<string, unknown> = {
    task: o.task,
    message: o.message,
  };
  if (o.task === undefined) {
    delete (data as any).task;
  } else {
    data.task = o.task;
  }
  return emitEvent("scope.guard_error", data, scope);
}

export function countByRule(events: MandaEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    if (ev.kind !== "scope.block") continue;
    const rule = ev.data?.rule;
    if (typeof rule === "string" && rule) {
      counts[rule] = (counts[rule] || 0) + 1;
    }
  }
  return counts;
}
