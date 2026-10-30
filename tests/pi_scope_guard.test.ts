import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../src/runtime/pi_scope_guard";

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => unknown;

function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, h: Handler) {
      (handlers[event] ??= []).push(h);
      return () => {};
    },
  };
  return { pi, handlers };
}

const ENV_KEYS = ["MANDA_SCOPE_TOUCH", "MANDA_SCOPE_FROZEN", "MANDA_SCOPE_ROOT", "GINGA_EVENTS"];
const saved: Record<string, string | undefined> = {};
let eventsFile = "";

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  eventsFile = join(mkdtempSync(join(tmpdir(), "scope-events-")), "events.jsonl");
  process.env.GINGA_EVENTS = eventsFile;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (existsSync(eventsFile)) rmSync(eventsFile, { force: true });
});

function setScope(root: string, touch: string[], frozen: string[]) {
  process.env.MANDA_SCOPE_ROOT = root;
  process.env.MANDA_SCOPE_TOUCH = JSON.stringify(touch);
  process.env.MANDA_SCOPE_FROZEN = JSON.stringify(frozen);
}

describe("pi_scope_guard (extensão tool_call)", () => {
  test("sem variáveis MANDA_SCOPE_* a extensão não registra nada", () => {
    const { pi, handlers } = fakePi();
    ext(pi as never);
    expect(handlers["tool_call"]).toBeUndefined();
  });

  test("com variáveis registra handler em tool_call: permite dentro e bloqueia fora", () => {
    const { pi, handlers } = fakePi();
    setScope("/wt", ["src/a.ts"], ["tests/frozen/"]);
    ext(pi as never);
    expect(handlers["tool_call"]).toBeDefined();
    const h = handlers["tool_call"]![0]!;
    expect(h({ toolName: "edit", input: { path: "src/a.ts" } }, {})).toBeUndefined();
    const r = h({ toolName: "edit", input: { path: "src/other.ts" } }, {}) as { block: boolean; reason: string };
    expect(r.block).toBe(true);
    expect(r.reason).toContain("src/other.ts");
    const f = h({ toolName: "write", input: { path: "tests/frozen/x.ts" } }, {}) as { block: boolean; reason: string };
    expect(f.block).toBe(true);
  });

  test("JSON inválido nas variáveis → libera e emite scope.guard_error", () => {
    const { pi, handlers } = fakePi();
    process.env.MANDA_SCOPE_ROOT = "/wt";
    process.env.MANDA_SCOPE_TOUCH = "{invalido";
    process.env.MANDA_SCOPE_FROZEN = "[]";
    ext(pi as never);
    expect(handlers["tool_call"]).toBeDefined();
    const h = handlers["tool_call"]![0]!;
    const r = h({ toolName: "edit", input: { path: "src/a.ts" } }, {});
    expect(r).toBeUndefined();
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const err = lines.find((e) => e.kind === "scope.guard_error");
    expect(err).toBeDefined();
    expect(typeof err.data.message).toBe("string");
  });

  test("exceção interna do handler → libera e emite scope.guard_error (fail-open)", () => {
    const { pi, handlers } = fakePi();
    setScope("/wt", ["src/a.ts"], []);
    ext(pi as never);
    expect(handlers["tool_call"]).toBeDefined();
    const h = handlers["tool_call"]![0]!;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "path", {
      get() {
        throw new Error("boom");
      },
    });
    const r = h({ toolName: "edit", input }, {});
    expect(r).toBeUndefined();
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const err = lines.find((e) => e.kind === "scope.guard_error");
    expect(err).toBeDefined();
    expect(err.data.message).toContain("boom");
  });
});
