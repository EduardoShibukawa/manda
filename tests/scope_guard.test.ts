import { describe, expect, test } from "bun:test";
import { decideToolCall } from "../src/runtime/scope_guard";
import type { Scope, ToolCall } from "../src/runtime/scope_guard";

const scope: Scope = {
  root: "/wt",
  touch: ["src/target.ts", "src/sub/**", "tests/scope_guard.test.ts", "tests/fixtures/x.ts"],
  frozen: ["tests/fixtures/**", "tests/frozen/"],
};

const call = (tool: string, input: Record<string, unknown>): ToolCall => ({ tool, input });

describe("decideToolCall", () => {
  test("edit/write dentro do touch → allow", () => {
    expect(decideToolCall(call("edit", { path: "src/target.ts" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("write", { path: "tests/scope_guard.test.ts" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("edit", { path: "src/sub/deep.ts" }), scope)).toEqual({ allow: true }); // glob src/sub/**
    expect(decideToolCall(call("edit", { path: "/wt/src/target.ts" }), scope)).toEqual({ allow: true }); // absoluto dentro da raiz
  });

  test("edit/write fora do touch → outside_touch com motivo legível", () => {
    const d = decideToolCall(call("edit", { path: "src/other.ts" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.rule).toBe("outside_touch");
      expect(d.reason).toContain("src/other.ts");
      expect(d.reason).toContain("BLOCKED: touch precisa incluir");
    }
  });

  test("frozen vence o touch", () => {
    const d = decideToolCall(call("write", { path: "tests/fixtures/x.ts" }), scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.rule).toBe("frozen");
    const d2 = decideToolCall(call("write", { path: "tests/frozen/y.ts" }), scope);
    expect(d2.allow).toBe(false);
    if (!d2.allow) expect(d2.rule).toBe("frozen");
  });

  test("escape de caminho → path_escape", () => {
    for (const p of ["../fora.ts", "/etc/passwd", "src/../../fora.ts"]) {
      const d = decideToolCall(call("edit", { path: p }), scope);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.rule).toBe("path_escape");
    }
  });

  test("bash com padrões de risco → bash_refused", () => {
    for (const cmd of [
      "git add -A",
      "git add .",
      "git commit -m x --no-verify",
      "git push --force origin main",
      "git push -f",
    ]) {
      const d = decideToolCall(call("bash", { command: cmd }), scope);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.rule).toBe("bash_refused");
    }
  });

  test("bash sem risco e outras tools → allow", () => {
    expect(decideToolCall(call("bash", { command: "git add src/target.ts" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("bash", { command: "bun test tests/scope_guard.test.ts" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("read", { path: "../../etc/passwd" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("grep", { pattern: "x" }), scope)).toEqual({ allow: true });
    expect(decideToolCall(call("edit", {}), scope)).toEqual({ allow: true }); // sem path não há o que bloquear
  });

  test("função pura: mesma entrada → mesma saída", () => {
    const c = call("edit", { path: "src/other.ts" });
    expect(decideToolCall(c, scope)).toEqual(decideToolCall(c, scope));
  });

  test("todo bloqueio traz reason não vazio", () => {
    const d = decideToolCall(call("bash", { command: "git add -A" }), scope);
    if (!d.allow) expect(typeof d.reason).toBe("string");
    if (!d.allow) expect(d.reason.length).toBeGreaterThan(0);
  });
});
