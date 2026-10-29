import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function manda(...args: string[]) {
  const r = Bun.spawnSync(["bun", "bin/manda.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("manda pipeline/lane", () => {
  test("pipeline sem args: uso, exit 2", () => {
    const r = manda("pipeline");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: manda pipeline");
  });
  test("lane sem args: uso, exit 2", () => {
    const r = manda("lane");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: manda lane");
  });
  test("kill_and_retry sem pid: uso, exit 2", () => {
    const r = manda("kill_and_retry");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: manda kill_and_retry");
  });
  test("rotate_model sem args: uso, exit 2", () => {
    const r = manda("rotate_model");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: manda rotate_model");
  });
});
