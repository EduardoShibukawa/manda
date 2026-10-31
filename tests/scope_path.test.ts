import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePath, matchesAny } from "../src/runtime/scope_path";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

describe("resolvePath", () => {
  test("relativo dentro da raiz → relativo normalizado", () => {
    const root = tmp("scope-root-");
    expect(resolvePath(root, "src/a.ts")).toEqual({ ok: true, rel: "src/a.ts" });
    expect(resolvePath(root, join(root, "src/a.ts"))).toEqual({ ok: true, rel: "src/a.ts" });
    expect(resolvePath(root, "src/./x/../a.ts")).toEqual({ ok: true, rel: "src/a.ts" });
  });

  test("escape por .. ou absoluto fora → path_escape", () => {
    const root = tmp("scope-root-");
    expect(resolvePath(root, "../fora.ts")).toEqual({ ok: false, rule: "path_escape" });
    expect(resolvePath(root, "/etc/passwd")).toEqual({ ok: false, rule: "path_escape" });
    expect(resolvePath(root, "a/../../fora.ts")).toEqual({ ok: false, rule: "path_escape" });
  });

  test("symlink que aponta para fora → path_escape; para dentro → ok", () => {
    const root = tmp("scope-root-");
    const fora = tmp("scope-fora-");
    writeFileSync(join(fora, "segredo.txt"), "x");
    symlinkSync(fora, join(root, "evil"));
    mkdirSync(join(root, "dentro"));
    symlinkSync(join(root, "dentro"), join(root, "bom"));
    expect(resolvePath(root, "evil/segredo.txt")).toEqual({ ok: false, rule: "path_escape" });
    expect(resolvePath(root, "bom/novo.ts")).toEqual({ ok: true, rel: "bom/novo.ts" });
  });

  test("arquivo inexistente com pai real dentro → ok", () => {
    const root = tmp("scope-root-");
    mkdirSync(join(root, "src"));
    expect(resolvePath(root, "src/novo.ts")).toEqual({ ok: true, rel: "src/novo.ts" });
  });
});

describe("matchesAny", () => {
  test("prefixo de diretório terminando em /", () => {
    expect(matchesAny("a/b.ts", ["a/"])).toBe(true);
    expect(matchesAny("a/x/b.ts", ["a/"])).toBe(true);
    expect(matchesAny("ab/b.ts", ["a/"])).toBe(false);
  });
  test("globs * e **", () => {
    expect(matchesAny("a/b.ts", ["a/**"])).toBe(true);
    expect(matchesAny("a/b.ts", ["a/*.ts"])).toBe(true);
    expect(matchesAny("a/x/b.ts", ["a/*.ts"])).toBe(false);
    expect(matchesAny("a/x/b.ts", ["**/*.ts"])).toBe(true);
  });
  test("comparação exata", () => {
    expect(matchesAny("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(matchesAny("src/a.ts", ["src/b.ts"])).toBe(false);
    expect(matchesAny("src/a.ts", [])).toBe(false);
  });
});

describe("scope_ignore.json", () => {
  test("arquivos gerados nunca contam", () => {
    const raw = readFileSync(join(import.meta.dir, "../src/runtime/scope_ignore.json"), "utf8");
    const ignore = JSON.parse(raw) as string[];
    expect(Array.isArray(ignore)).toBe(true);
    for (const rel of ["bun.lock", "node_modules/x/index.js", "a/__pycache__/x.pyc", "x.pyc"]) {
      expect(matchesAny(rel, ignore)).toBe(true);
    }
    expect(matchesAny("src/a.ts", ignore)).toBe(false);
  });
});
