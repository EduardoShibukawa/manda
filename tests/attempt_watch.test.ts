import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { breakerOf, recordFailure } from "../src/breaker";
import type { RunObs } from "../src/run_state";
import { watchAttempt } from "../src/attempt_watch";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const CFG = { patience_min: 5, no_progress_min: 10 };

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "manda-watch-"));
  return new Database(join(dir, "state.db"));
}

function obs(p: Partial<RunObs>): RunObs {
  return {
    since_last_event_s: 0,
    stream_bytes: 100,
    cpu_pct: 50,
    files_changed: true,
    probe_ok: true,
    exit: null,
    stderr_tail: "",
    ...p,
  };
}

const TRAVADO: RunObs = obs({
  since_last_event_s: 700, // > no_progress_min (10 min = 600 s)
  stream_bytes: 50,
  cpu_pct: 0,
  files_changed: false,
  probe_ok: false,
});

const RECUSADO: RunObs = obs({ exit: 1, stderr_tail: "429 Too Many Requests — usage limit reached" });

const NA_FILA: RunObs = obs({
  since_last_event_s: 60, // dentro de patience_min (5 min)
  stream_bytes: 0,
  probe_ok: true,
});

const OK: RunObs = obs({ exit: 0 });

function seq(...samples: RunObs[]) {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)]!;
}

const noSleep = async (_ms: number) => {};

const savedEvents = process.env.GINGA_EVENTS;
afterEach(() => {
  if (savedEvents === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = savedEvents;
});

describe("watchAttempt", () => {
  test("sucesso (exit 0) → outcome done, recordSuccess, sem kill, amostra a cada 30 s", async () => {
    const db = tempDb();
    let killed = 0;
    const sleeps: number[] = [];
    const r = await watchAttempt({
      sample: seq(obs({ since_last_event_s: 30 }), OK),
      kill: () => {
        killed++;
      },
      probe: async () => ({ ok: true }),
      db,
      model: "opencode/glm-5.3-flash-free",
      cfg: CFG,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.outcome).toBe("done");
    expect(killed).toBe(0);
    expect(breakerOf(db, "opencode/glm-5.3-flash-free", NOW).state).toBe("closed");
    expect(sleeps).toContain(30_000);
  });

  test("travado → kill pelo pid, disjuntor abre, troca de modelo e emite attempt com failure", async () => {
    const db = tempDb();
    const dir = mkdtempSync(join(tmpdir(), "manda-watch-ev-"));
    const evFile = join(dir, "events.jsonl");
    process.env.GINGA_EVENTS = evFile;
    try {
      let killed = 0;
      const r = await watchAttempt({
        sample: seq(TRAVADO),
        kill: () => {
          killed++;
        },
        probe: async () => ({ ok: false }),
        db,
        model: "opencode/glm-5.3-flash-free",
        cfg: CFG,
        sleep: noSleep,
      });
      expect(killed).toBe(1);
      expect(breakerOf(db, "opencode/glm-5.3-flash-free", NOW).state).toBe("open");
      expect(r.outcome).toBe("switched");
      expect(typeof r.next).toBe("string");
      const events = readFileSync(evFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const att = events.find((e) => e.kind === "attempt");
      expect(att).toBeDefined();
      expect(att.data.failure).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recusado → recordFailure e troca, sem kill (o processo já saiu)", async () => {
    const db = tempDb();
    let killed = 0;
    const r = await watchAttempt({
      sample: seq(RECUSADO),
      kill: () => {
        killed++;
      },
      probe: async () => ({ ok: true }),
      db,
      model: "opencode-go/qwen3.8-flash",
      cfg: CFG,
      sleep: noSleep,
    });
    expect(killed).toBe(0);
    expect(breakerOf(db, "opencode-go/qwen3.8-flash", NOW).state).toBe("open");
    expect(r.outcome).toBe("switched");
  });

  test("na_fila dentro da paciência → espera amostrando e depois conclude done", async () => {
    const db = tempDb();
    let killed = 0;
    const sleeps: number[] = [];
    const r = await watchAttempt({
      sample: seq(NA_FILA, NA_FILA, OK),
      kill: () => {
        killed++;
      },
      probe: async () => ({ ok: true }),
      db,
      model: "opencode/glm-5.3-flash-free",
      cfg: CFG,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.outcome).toBe("done");
    expect(killed).toBe(0);
    expect(sleeps.filter((ms) => ms === 30_000).length).toBe(2);
    // nunca abriu disjuntor: não houve falha
    expect(breakerOf(db, "opencode/glm-5.3-flash-free", NOW).state).toBe("closed");
  });

  test("falha atrás de falha no mesmo modelo → disjuntor escala (level 2)", async () => {
    const db = tempDb();
    recordFailure(db, "m1", "timeout", NOW); // level 1
    await watchAttempt({
      sample: seq(TRAVADO),
      kill: () => {},
      probe: async () => ({ ok: false }),
      db,
      model: "m1",
      cfg: CFG,
      sleep: noSleep,
    });
    const b = breakerOf(db, "m1", NOW);
    expect(b.state).toBe("open");
    expect(b.level).toBe(2);
  });
});
