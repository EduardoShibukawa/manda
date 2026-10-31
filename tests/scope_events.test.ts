import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitScopeBlock, emitScopeGuardError, countByRule } from "../src/runtime/scope_events";
import type { MandaEvent } from "../src/events";

const saved = process.env.GINGA_EVENTS;
beforeEach(() => {
  delete process.env.GINGA_EVENTS;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved;
});

describe("eventos scope.* (v1, sem conteúdo de arquivo)", () => {
  test("scope.block carrega { task, tool, path, rule } no envelope v1", () => {
    const e = emitScopeBlock({ task: "T162", tool: "edit", path: "src/other.ts", rule: "outside_touch" });
    expect(e.v).toBe(1);
    expect(e.kind).toBe("scope.block");
    expect(e.source).toBe("manda");
    expect(e.task).toBe("T162");
    expect(e.data).toEqual({ task: "T162", tool: "edit", path: "src/other.ts", rule: "outside_touch" });
    expect(JSON.stringify(e)).not.toContain("content");
  });

  test("scope.guard_error carrega { task, message }", () => {
    const e = emitScopeGuardError({ task: "T164", message: "boom" });
    expect(e.v).toBe(1);
    expect(e.kind).toBe("scope.guard_error");
    expect(e.data).toEqual({ task: "T164", message: "boom" });
  });

  test("com GINGA_EVENTS cada evento vira uma linha JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-ev-"));
    const f = join(dir, "events.jsonl");
    process.env.GINGA_EVENTS = f;
    emitScopeBlock({ task: "T1", tool: "bash", path: "", rule: "bash_refused" });
    emitScopeGuardError({ task: "T1", message: "x" });
    const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["scope.block", "scope.guard_error"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("countByRule conta scope.block por regra", () => {
    const events: MandaEvent[] = [
      emitScopeBlock({ task: "T1", tool: "edit", path: "a", rule: "outside_touch" }),
      emitScopeBlock({ task: "T1", tool: "edit", path: "b", rule: "outside_touch" }),
      emitScopeBlock({ task: "T2", tool: "write", path: "c", rule: "frozen" }),
      emitScopeGuardError({ task: "T3", message: "boom" }),
    ];
    expect(countByRule(events)).toEqual({ outside_touch: 2, frozen: 1 });
  });
});
