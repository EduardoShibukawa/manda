import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T911: `manda red` e `manda replan` acham o gate por `[commands].gate_cli`
 * (padrão `pinga`), não por nome fixo na CLI.
 */
const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ws(toml?: string): string {
  const d = mkdtempSync(join(tmpdir(), "manda-gatecli-"));
  dirs.push(d);
  if (toml !== undefined) {
    mkdirSync(join(d, ".ginga"), { recursive: true });
    writeFileSync(join(d, ".ginga", "project.toml"), toml);
  }
  return d;
}

describe("gateCli", () => {
  test("sem project.toml ou sem a chave: pinga", async () => {
    const { gateCli } = await import(join(ROOT, "src/project.ts"));
    expect(gateCli(ws())).toEqual(["pinga"]);
    expect(gateCli(ws("[commands]\n"))).toEqual(["pinga"]);
    expect(gateCli(ws('[commands]\ngate_cli = "  "\n'))).toEqual(["pinga"]);
  });

  test("valor configurado vira o prefixo do comando, com argumentos", async () => {
    const { gateCli } = await import(join(ROOT, "src/project.ts"));
    expect(gateCli(ws('[commands]\ngate_cli = "meu-gate"\n'))).toEqual(["meu-gate"]);
    expect(gateCli(ws('[commands]\ngate_cli = "bun /opt/p-inga/bin/pinga.ts"\n'))).toEqual(["bun", "/opt/p-inga/bin/pinga.ts"]);
  });
});

test("a CLI não chama mais pinga por nome fixo", () => {
  const cli = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
  expect(cli).not.toMatch(/spawnSync\(\s*\[\s*"pinga"/);
  expect(cli).toContain("gateCli(");
});
