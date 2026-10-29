import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TASK-05 (PLAN-0009): provider rg + git no `manda context`.
 * outline: regex de definição por linguagem via `rg -n`. slice: definição + N linhas.
 * impact: `git grep -l` + co-change de `git log --name-only`. Mesmo schema único da TASK-04.
 * Hermetismo: rg e git reais de /usr/bin; o repo git de impact nasce num tmpdir por teste;
 * sem dependência além de rg e git. O gira falso de `fixtures/context/bin` serve só à paridade.
 */

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "manda.ts");
const FX = join(ROOT, "tests", "fixtures", "context");
const PATH_RG = "/usr/bin:/bin";
const PATH_FAKE = `${join(FX, "bin")}:/usr/bin:/bin`;
const PATH_NO_GIRA = "/usr/bin:/bin";

function manda(args: string[], cwd: string, path = PATH_RG) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd,
    env: { PATH: path, HOME: "/tmp", TMPDIR: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function jsonOk(r: { code: number; out: string; err: string }): any {
  expect(r.code).toBe(0);
  expect(r.out.length).toBeGreaterThan(0);
  return JSON.parse(r.out);
}

function expectItem(it: any): void {
  expect(typeof it.path).toBe("string");
  expect(it.path.length).toBeGreaterThan(0);
  expect(Number.isInteger(it.line)).toBe(true);
  expect(it.line).toBeGreaterThan(0);
  expect(typeof it.symbol).toBe("string");
  expect(it.symbol.length).toBeGreaterThan(0);
  expect(typeof it.kind).toBe("string");
  expect(typeof it.text).toBe("string");
}

const pathsOf = (j: any): string[] => [...new Set((j.items as any[]).map((i) => i.path))].sort();
const symbolsOf = (j: any): string[] => [...new Set((j.items as any[]).map((i) => i.symbol))];
const itemKeysOf = (j: any): string[] =>
  [...new Set((j.items as any[]).flatMap((i) => Object.keys(i)))].sort();

function lineOf(file: string, needle: string): number {
  const lines = readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  expect(i).toBeGreaterThanOrEqual(0);
  return i + 1;
}

const RG = join(FX, "root-rg");
const APP = join(RG, "src", "app.ts");
const STORE = join(RG, "src", "store.ts");

describe("manda context — provider rg: outline (rg -n por linguagem)", () => {
  test("outline src/app.ts via rg acha as definições ts com path/line/symbol/kind/text", () => {
    const j = jsonOk(manda(["context", "outline", "src/app.ts", "--json"], RG));
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("rg");
    expect(j.capability).toBe("outline");
    expect(j.items.length).toBeGreaterThan(0);
    j.items.forEach(expectItem);
    expect(pathsOf(j)).toEqual(["src/app.ts"]);
    expect(symbolsOf(j)).toContain("Greeter");
    expect(symbolsOf(j)).toContain("greet");
    const greeter = j.items.find((i: any) => i.symbol === "Greeter");
    expect(greeter.line).toBe(lineOf(APP, "export class Greeter"));
    expect(greeter.kind).toBe("class");
    const greet = j.items.find((i: any) => i.symbol === "greet");
    expect(greet.line).toBe(lineOf(APP, "export function greet"));
    expect(greet.kind).toBe("function");
  });

  test("outline src/store.ts via rg cobre classe, interface e função", () => {
    const j = jsonOk(manda(["context", "outline", "src/store.ts", "--json"], RG));
    expect(j.provider).toBe("rg");
    j.items.forEach(expectItem);
    expect(pathsOf(j)).toEqual(["src/store.ts"]);
    const syms = symbolsOf(j);
    expect(syms).toContain("Store");
    expect(syms).toContain("MemoryStore");
    expect(syms).toContain("describe");
    const mem = j.items.find((i: any) => i.symbol === "MemoryStore");
    expect(mem.line).toBe(lineOf(STORE, "export class MemoryStore"));
    expect(mem.kind).toBe("class");
    const iface = j.items.find((i: any) => i.symbol === "Store");
    expect(iface.line).toBe(lineOf(STORE, "export interface Store"));
    expect(iface.kind).toBe("interface");
  });

  test("arquivo sem definições conhecidas → items [] sem quebrar", () => {
    const j = jsonOk(manda(["context", "outline", ".ginga/project.toml", "--json"], RG));
    expect(j.provider).toBe("rg");
    expect(j.items).toEqual([]);
  });
});

describe("manda context — provider rg: slice (definição + N linhas)", () => {
  test("slice Greeter via rg traz a definição com as linhas seguintes", () => {
    const j = jsonOk(manda(["context", "slice", "Greeter", "--json"], RG));
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("rg");
    expect(j.capability).toBe("slice");
    j.items.forEach(expectItem);
    const greeter = j.items.find((i: any) => i.symbol === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter.path).toBe("src/app.ts");
    expect(greeter.line).toBe(lineOf(APP, "export class Greeter"));
    expect(greeter.text).toContain("class Greeter");
    expect(greeter.text).toContain("constructor");
  });

  test("paridade com o gira: slice via rg e via gira (saída gravada) têm o mesmo schema e os mesmos paths", () => {
    const giraJ = jsonOk(
      manda(["context", "slice", "contract:src/app.ts:Greeter", "--json"], join(FX, "root-gira"), PATH_FAKE),
    );
    expect(giraJ.provider).toBe("gira");
    const rgJ = jsonOk(manda(["context", "slice", "Greeter", "--json"], RG));
    expect(Object.keys(rgJ).sort()).toEqual(Object.keys(giraJ).sort());
    expect(pathsOf(rgJ)).toEqual(pathsOf(giraJ));
    expect(itemKeysOf(rgJ)).toEqual(itemKeysOf(giraJ));
  });
});

describe("manda context — provider rg: impact (git grep + co-change)", () => {
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "manda-ctx-git-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".ginga"), { recursive: true });
    writeFileSync(join(dir, ".ginga", "project.toml"), '[context]\nprovider = "rg"\n');
    writeFileSync(join(dir, "src", "app.ts"), readFileSync(APP, "utf8"));
    writeFileSync(join(dir, "src", "store.ts"), readFileSync(STORE, "utf8"));
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if ((r.exitCode ?? 1) !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    };
    git("init", "-q");
    git("config", "user.name", "teste");
    git("config", "user.email", "teste@example.com");
    git("add", "-A");
    git("commit", "-qm", "app+store juntos");
    writeFileSync(join(dir, "src", "app.ts"), readFileSync(APP, "utf8") + "// mexido\n");
    writeFileSync(join(dir, "src", "store.ts"), readFileSync(STORE, "utf8") + "// mexido\n");
    git("add", "-A");
    git("commit", "-qm", "app+store mexidos");
    return dir;
  }

  test("impact greet via rg: git grep acha os refs e o co-change soma os paths", () => {
    const dir = gitRepo();
    try {
      const j = jsonOk(manda(["context", "impact", "greet", "--json"], dir));
      expect(j.provider).toBe("rg");
      expect(j.capability).toBe("impact");
      j.items.forEach(expectItem);
      expect(pathsOf(j)).toEqual(["src/app.ts", "src/store.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("impact de um path: o próprio arquivo aparece e nada quebra", () => {
    const dir = gitRepo();
    try {
      const j = jsonOk(manda(["context", "impact", "src/app.ts", "--json"], dir));
      expect(j.provider).toBe("rg");
      j.items.forEach(expectItem);
      expect(pathsOf(j)).toContain("src/app.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("impact fora de repo git → {items:[], unsupported:true} com exit 0", () => {
    // root-rg não serve: fica dentro do repo manda (git grep acharia os fixtures). tmpdir puro.
    const dir = mkdtempSync(join(tmpdir(), "manda-ctx-nogit-"));
    try {
      mkdirSync(join(dir, ".ginga"), { recursive: true });
      writeFileSync(join(dir, ".ginga", "project.toml"), '[context]\nprovider = "rg"\n');
      const j = jsonOk(manda(["context", "impact", "greet", "--json"], dir));
      expect(j.provider).toBe("rg");
      expect(j.items).toEqual([]);
      expect(j.unsupported).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manda context — rg no fallback e em extras", () => {
  test("gira sem binário cai para o rg real e acha o Greeter", () => {
    const r = manda(["context", "outline", "src/app.ts", "--json"], join(FX, "root-gira"), PATH_NO_GIRA);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/gira/);
    expect(r.err).toMatch(/rg/);
    const j = JSON.parse(r.out);
    expect(j.provider).toBe("rg");
    expect(symbolsOf(j)).toContain("Greeter");
  });

  test("extra gira:tour no provider rg degrada para unsupported sem quebrar", () => {
    const j = jsonOk(manda(["context", "gira:tour", "--json"], RG));
    expect(j.provider).toBe("rg");
    expect(j.capability).toBe("gira:tour");
    expect(j.items).toEqual([]);
    expect(j.unsupported).toBe(true);
  });
});
