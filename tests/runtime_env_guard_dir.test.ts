import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T904: o checkout do ginga (dono do guard de segredos) é achado por
 * GUARD_DIR, GINGA_HOME ou pelo `ginga` do PATH, e não pelo nome da pasta
 * vizinha. O clone do GitHub se chama `g-inga`; no homelab, `ginga`.
 */
const ROOT = join(import.meta.dir, "..");
const load = async (): Promise<any> => import(join(ROOT, "src", "runtime", "env.ts"));
const scratch: string[] = [];

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "manda-guarddir-")));
  scratch.push(d);
  return d;
}

/** Checkout falso do ginga com bin/ginga.ts e contrib/guard/pi.ts. */
function fakeGinga(): string {
  const repo = tmp();
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(join(repo, "contrib", "guard"), { recursive: true });
  writeFileSync(join(repo, "bin", "ginga.ts"), "#!/usr/bin/env bun\n");
  writeFileSync(join(repo, "contrib", "guard", "pi.ts"), "export {};\n");
  return repo;
}

afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("guardDir", () => {
  test("GUARD_DIR do request vence tudo", async () => {
    const { guardDir } = await load();
    expect(guardDir({ GUARD_DIR: "/x/guard", GINGA_HOME: "/y/ginga", PATH: "" })).toBe("/x/guard");
  });

  test("GINGA_HOME vale quando não há GUARD_DIR", async () => {
    const { guardDir } = await load();
    expect(guardDir({ GINGA_HOME: "/y/ginga", PATH: "" })).toBe("/y/ginga");
  });

  test("sem variáveis: segue o symlink `ginga` do PATH até a raiz do checkout", async () => {
    const repo = fakeGinga();
    const bin = tmp();
    symlinkSync(join(repo, "bin", "ginga.ts"), join(bin, "ginga"));
    const { guardDir } = await load();
    expect(guardDir({ PATH: bin })).toBe(repo);
  });

  test("`ginga` do PATH que não aponta para um checkout com guard é ignorado", async () => {
    const bin = tmp();
    writeFileSync(join(bin, "ginga"), "#!/bin/sh\n", { mode: 0o755 });
    const { guardDir, siblingGuardDir } = await load();
    expect(guardDir({ PATH: bin })).toBe(siblingGuardDir());
  });

  test("pasta vizinha: aceita `ginga` e `g-inga`, a primeira que tiver contrib/guard", async () => {
    const { siblingGuardDir } = await load();
    const parent = tmp();
    mkdirSync(join(parent, "g-inga", "contrib", "guard"), { recursive: true });
    expect(siblingGuardDir(parent)).toBe(join(parent, "g-inga"));
    mkdirSync(join(parent, "ginga", "contrib", "guard"), { recursive: true });
    expect(siblingGuardDir(parent)).toBe(join(parent, "ginga"));
  });

  test("nenhuma vizinha com guard: devolve `ginga` (os adapters falham fechado)", async () => {
    const { siblingGuardDir } = await load();
    const parent = tmp();
    expect(siblingGuardDir(parent)).toBe(join(parent, "ginga"));
  });
});
