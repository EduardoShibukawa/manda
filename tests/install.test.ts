import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "manda.ts");

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "manda-install-")));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function manda(args: string[], extraPath = "") {
  const env: Record<string, string> = { PATH: `${extraPath ? extraPath + ":" : ""}/usr/bin:/bin`, HOME: home };
  return Bun.spawnSync([process.execPath, BIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
}

describe("manda install", () => {
  test("cria ~/.local/bin/manda apontando para bin/manda.ts e o link roda --help", () => {
    const r = manda(["install"]);
    expect(r.exitCode).toBe(0);
    const link = join(home, ".local", "bin", "manda");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(BIN));
    const h = Bun.spawnSync([link, "--help"], { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(h.exitCode).toBe(0);
    expect(h.stdout.toString()).toContain("Usage: manda");
  });

  test("avisa quando ~/.local/bin não está no PATH", () => {
    const r = manda(["install"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("PATH");
  });

  test("não avisa quando ~/.local/bin já está no PATH", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const r = manda(["install"], join(home, ".local", "bin"));
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).not.toContain("PATH");
  });

  test("idempotente: segunda execução mantém o link e sai 0", () => {
    expect(manda(["install"]).exitCode).toBe(0);
    const link = join(home, ".local", "bin", "manda");
    const first = readlinkSync(link);
    expect(manda(["install"]).exitCode).toBe(0);
    expect(readlinkSync(link)).toBe(first);
  });

  test("--help e -h saem 0 com o uso", () => {
    for (const flag of ["--help", "-h"]) {
      const r = manda([flag]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("Usage: manda");
    }
  });
});
