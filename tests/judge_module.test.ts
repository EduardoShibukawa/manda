import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("judge module unificado", () => {
  test("shim src/judge-run.ts nao existe (um unico modulo)", () => {
    expect(existsSync(join(ROOT, "src", "judge-run.ts"))).toBe(false);
  });
});