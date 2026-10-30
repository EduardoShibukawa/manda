import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolCall } from "../src/runtime/scope_guard";
import type { Scope, ToolCall } from "../src/runtime/scope_guard";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const call = (tool: string, input: Record<string, unknown>): ToolCall => ({ tool, input });

describe("scope_guard_paths", () => {
  test("frozen docs/** bloqueia docs/x.ts e docs/a/b.ts", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["src/**"], frozen: ["docs/**"] };
    const d1 = decideToolCall(call("edit", { path: "docs/x.ts" }), scope);
    expect(d1.allow).toBe(false);
    if (!d1.allow) expect(d1.rule).toBe("frozen");
    const d2 = decideToolCall(call("write", { path: "docs/a/b.ts" }), scope);
    expect(d2.allow).toBe(false);
    if (!d2.allow) expect(d2.rule).toBe("frozen");
  });

  test("touch src/** permite src/a.ts e bloqueia lib/a.ts com outside_touch", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["src/**"], frozen: [] };
    expect(decideToolCall(call("edit", { path: "src/a.ts" }), scope)).toEqual({ allow: true });
    const d = decideToolCall(call("edit", { path: "lib/a.ts" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe("outside_touch");
  });

  test("touch tests/** + frozen tests/golden/** bloqueia tests/golden/a.ts", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["tests/**"], frozen: ["tests/golden/**"] };
    const d = decideToolCall(call("write", { path: "tests/golden/a.ts" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe("frozen");
  });

  test("absoluto fora da raiz e .. e subida → path_escape", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["**/*"], frozen: [] };
    for (const p of ["/tmp/x.ts", "/etc/hosts", "../x.ts", "src/../../x.ts"]) {
      const d = decideToolCall(call("edit", { path: p }), scope);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.rule).toBe("path_escape");
    }
  });

  test("absoluto dentro da raiz equivale ao relativo", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["src/**"], frozen: [] };
    expect(decideToolCall(call("edit", { path: join(root, "src/a.ts") }), scope)).toEqual({ allow: true });
  });

  test("symlink dentro da raiz apontando para fora → path_escape", () => {
    const root = tmp("scope-root-");
    const fora = tmp("scope-fora-");
    writeFileSync(join(fora, "segredo.txt"), "x");
    symlinkSync(fora, join(root, "evil"));
    const scope: Scope = { root, touch: ["**/*"], frozen: [] };
    const d = decideToolCall(call("edit", { path: "evil/segredo.txt" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe("path_escape");
  });

  test("arquivo de touch exato permite só ele", () => {
    const root = tmp("scope-root-");
    const scope: Scope = { root, touch: ["src/only.ts"], frozen: [] };
    expect(decideToolCall(call("edit", { path: "src/only.ts" }), scope)).toEqual({ allow: true });
    const d = decideToolCall(call("edit", { path: "src/other.ts" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe("outside_touch");
  });
});
