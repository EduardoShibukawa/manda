import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { breakerOf, recordFailure } from "../src/breaker";
import { breakerStatus, breakerReset } from "../src/breaker_cli";

const ROOT = join(import.meta.dir, "..");

const NOW = new Date("2026-10-31T12:00:00.000Z");

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "manda-breaker-cli-"));
  return new Database(join(dir, "state.db"));
}

function manda(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", join(ROOT, "bin", "manda.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const savedEvents = process.env.GINGA_EVENTS;
afterEach(() => {
  if (savedEvents === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = savedEvents;
});

describe("breakerStatus", () => {
  test("lista cada modelo com model/state/until/level/last_reason", () => {
    const db = tempDb();
    recordFailure(db, "opencode/glm-5.3-flash-free", "timeout", NOW);
    recordFailure(db, "opencode-go/qwen3.8-flash", "429", NOW);
    const list = breakerStatus(db, new Date(NOW.getTime() + 5 * 60_000));
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    const m1 = list.find((x) => x.model === "opencode/glm-5.3-flash-free");
    expect(m1).toBeDefined();
    expect(m1!.state).toBe("open");
    expect(m1!.level).toBe(1);
    expect(m1!.last_reason).toBe("timeout");
    expect(typeof m1!.until).toBe("string");
  });

  test("modelo vencido → half_open; sem linha não aparece", () => {
    const db = tempDb();
    recordFailure(db, "m1", "x", NOW); // abre por 10 min
    const list = breakerStatus(db, new Date(NOW.getTime() + 11 * 60_000));
    expect(list.find((x) => x.model === "m1")!.state).toBe("half_open");
    expect(list.find((x) => x.model === "desconhecido")).toBeUndefined();
  });
});

describe("breakerReset", () => {
  test("reset → recordSuccess (closed) e emite evento transition", () => {
    const db = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "manda-breaker-ev-"));
    const evFile = join(dir, "events.jsonl");
    process.env.GINGA_EVENTS = evFile;
    try {
      recordFailure(db, "m1", "timeout", NOW);
      expect(breakerOf(db, "m1", NOW).state).toBe("open");
      breakerReset(db, "m1");
      expect(breakerOf(db, "m1", NOW).state).toBe("closed");
      const events = readFileSync(evFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const tr = events.find((e) => e.kind === "transition");
      expect(tr).toBeDefined();
      expect(tr.data.model).toBe("m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI: subcomando breaker", () => {
  test("breaker status --json → exit 0 e array JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-breaker-cli-cwd-"));
    try {
      const r = manda(dir, "breaker", "status", "--json");
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(Array.isArray(j)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaker reset <modelo> → exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-breaker-cli-cwd-"));
    try {
      const r = manda(dir, "breaker", "reset", "opencode/glm-5.3-flash-free");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaker sem subcomando → exit 2 (usage)", () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-breaker-cli-cwd-"));
    try {
      expect(manda(dir, "breaker").code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
