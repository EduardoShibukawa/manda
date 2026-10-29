import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TASK-04 (PLAN-0009): porta de contexto `manda context <cap> <arg> --json`.
 * Provider do `.ginga/project.toml` (`gira|rg|<comando>`); adapter gira normaliza a saída do
 * gira no schema único {schema_version, provider, capability, items:[{path,line,symbol,kind,text}]}.
 * Hermetismo: gira falso + provedores custom em `tests/fixtures/context/bin/` via PATH controlado;
 * saídas gravadas do gira real v0.3.0 em `gira-out/`. O rg real é a TASK-05 (aqui só o fallback
 * resolve o provider e avisa; nada de items do rg é pinado neste ficheiro).
 */

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "manda.ts");
const FX = join(ROOT, "tests", "fixtures", "context");
const PATH_FAKE = `${join(FX, "bin")}:/usr/bin:/bin`;
const PATH_NO_GIRA = "/usr/bin:/bin";

function manda(args: string[], cwd: string, path = PATH_FAKE) {
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

describe("manda context — provider gira (adapter + schema único)", () => {
  test("outline normaliza os nodes do gira em items {path,line,symbol,kind,text}", () => {
    const j = jsonOk(manda(["context", "outline", "src/app.ts", "--json"], join(FX, "root-gira")));
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("gira");
    expect(j.capability).toBe("outline");
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.length).toBeGreaterThan(0);
    j.items.forEach(expectItem);
    expect(pathsOf(j)).toEqual(["src/app.ts"]);
    const greeter = j.items.find((i: any) => i.symbol === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter.path).toBe("src/app.ts");
    expect(greeter.line).toBe(5);
    expect(String(greeter.kind).toLowerCase()).toMatch(/class|contract/);
    expect(greeter.text).toContain("Greeter");
  });

  test("slice: nó focal do gira vira item com path/line do evidence locator", () => {
    const j = jsonOk(manda(["context", "slice", "contract:src/app.ts:Greeter", "--json"], join(FX, "root-gira")));
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("gira");
    expect(j.capability).toBe("slice");
    j.items.forEach(expectItem);
    expect(pathsOf(j)).toEqual(["src/app.ts"]);
    expect(j.items.some((i: any) => i.symbol === "Greeter" && i.line === 5)).toBe(true);
  });

  test("impact: contratos afetados viram items", () => {
    const j = jsonOk(manda(["context", "impact", "contract:src/app.ts:Greeter", "--json"], join(FX, "root-gira")));
    expect(j.provider).toBe("gira");
    expect(j.capability).toBe("impact");
    j.items.forEach(expectItem);
    expect(pathsOf(j)).toEqual(["src/app.ts"]);
    expect(j.items.some((i: any) => i.symbol === "Greeter")).toBe(true);
  });

  test("extras ficam em namespace próprio (gira:tour)", () => {
    const j = jsonOk(manda(["context", "gira:tour", "--json"], join(FX, "root-gira")));
    expect(j.provider).toBe("gira");
    expect(j.capability).toBe("gira:tour");
    expect(j.items.length).toBeGreaterThan(0);
    j.items.forEach(expectItem);
    expect(j.items.some((i: any) => /compose\.yaml$/.test(i.path) && i.line === 253)).toBe(true);
  });

  test("capabilities do gira expõe as capacidades núcleo na saída --json", () => {
    const r = manda(["context", "capabilities", "--json"], join(FX, "root-gira"));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("gira");
    expect(j.capability).toBe("capabilities");
    for (const cap of ["outline", "slice", "impact"]) {
      expect(r.out).toContain(cap);
    }
  });

  test("extra desconhecido degrada sem quebrar", () => {
    const j = jsonOk(manda(["context", "gira:bogus", "--json"], join(FX, "root-gira")));
    expect(j.capability).toBe("gira:bogus");
    expect(j.items).toEqual([]);
    expect(j.unsupported).toBe(true);
  });
});

describe("manda context — provider <comando> (estilo credential helper)", () => {
  test("comando custom no PATH fala o protocolo e a saída em schema único passa", () => {
    const j = jsonOk(manda(["context", "outline", "x.ts", "--json"], join(FX, "root-cmd")));
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("ctx-minimal");
    expect(j.capability).toBe("outline");
    expect(j.items).toEqual([{ path: "x.ts", line: 1, symbol: "x", kind: "function", text: "export function x() {}" }]);
  });

  test("capacidade ausente no provedor → {items:[], unsupported:true} com exit 0", () => {
    const j = jsonOk(manda(["context", "slice", "QualquerCoisa", "--json"], join(FX, "root-cmd")));
    expect(j.provider).toBe("ctx-minimal");
    expect(j.capability).toBe("slice");
    expect(j.items).toEqual([]);
    expect(j.unsupported).toBe(true);
  });

  test("provedor que não existe no PATH degrada sem quebrar", () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-ctx-"));
    try {
      mkdirSync(join(dir, ".ginga"), { recursive: true });
      writeFileSync(join(dir, ".ginga", "project.toml"), '[context]\nprovider = "ctx-nao-existe"\n');
      const j = jsonOk(manda(["context", "outline", "x.ts", "--json"], dir));
      expect(j.items).toEqual([]);
      expect(j.unsupported).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manda context — fallback e usage", () => {
  test("provider gira sem binário no PATH cai para rg com aviso no stderr", () => {
    const r = manda(["context", "outline", "src/app.ts", "--json"], join(FX, "root-gira"), PATH_NO_GIRA);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/gira/);
    expect(r.err).toMatch(/rg/);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.provider).toBe("rg");
    expect(j.capability).toBe("outline");
    expect(Array.isArray(j.items)).toBe(true);
  });

  test("faltam capacidade ou argumento → exit 2 de usage", () => {
    expect(manda(["context"], join(FX, "root-gira")).code).toBe(2);
    expect(manda(["context", "outline", "--json"], join(FX, "root-gira")).code).toBe(2);
  });
});
