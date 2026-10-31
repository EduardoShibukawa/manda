import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

import { breakerOf, recordFailure, recordSuccess } from "../src/breaker";

const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_breaker (
    model TEXT PRIMARY KEY,
    level INTEGER DEFAULT 0,
    opened_at TEXT,
    until TEXT,
    last_reason TEXT
  );
`;

function tempDbPath(): string {
  return join(tmpdir(), `manda-breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function freshDb(path: string): Database {
  const db = new Database(path);
  db.exec(TABLE_SCHEMA);
  return db;
}

describe("breakerOf — estado inicial", () => {
  test("sem linha → closed, level 0, until null", () => {
    const db = freshDb(tempDbPath());
    const r = breakerOf(db, "opencode/free", new Date("2026-10-30T00:00:00Z"));
    expect(r.state).toBe("closed");
    expect(r.level).toBe(0);
    expect(r.until).toBeNull();
  });
});

describe("recordFailure — escalada 10/30/120 min", () => {
  const now = new Date("2026-10-30T00:00:00.000Z");
  const path = tempDbPath();
  const db = freshDb(path);
  const model = "opencode/glm-5.3-flash-free";

  test("1ª falha → level 1, open, until +10 min", () => {
    recordFailure(db, model, "timeout", now);
    const r = breakerOf(db, model, now);
    expect(r.state).toBe("open");
    expect(r.level).toBe(1);
    expect(new Date(r.until!).getTime()).toBeCloseTo(now.getTime() + 10 * 60_000, -1);
  });

  test("2ª falha → level 2, open, until +30 min", () => {
    recordFailure(db, model, "timeout", now);
    const r = breakerOf(db, model, now);
    expect(r.state).toBe("open");
    expect(r.level).toBe(2);
    expect(new Date(r.until!).getTime()).toBeCloseTo(now.getTime() + 30 * 60_000, -1);
  });

  test("3ª falha → level 3, open, until +120 min", () => {
    recordFailure(db, model, "timeout", now);
    const r = breakerOf(db, model, now);
    expect(r.state).toBe("open");
    expect(r.level).toBe(3);
    expect(new Date(r.until!).getTime()).toBeCloseTo(now.getTime() + 120 * 60_000, -1);
  });

  test("4ª falha → capped no level 3", () => {
    recordFailure(db, model, "timeout", now);
    const r = breakerOf(db, model, now);
    expect(r.state).toBe("open");
    expect(r.level).toBe(3);
    expect(new Date(r.until!).getTime()).toBeCloseTo(now.getTime() + 120 * 60_000, -1);
  });

  test("modelos são independentes", () => {
    recordFailure(db, "opencode/outro", "quota_exhausted", now);
    const r = breakerOf(db, "opencode/outro", now);
    expect(r.level).toBe(1);
    expect(r.state).toBe("open");
    // o primeiro modelo continua intacto
    const r2 = breakerOf(db, model, now);
    expect(r2.level).toBe(3);
  });
});

describe("breakerOf — expirado → half_open", () => {
  const path = tempDbPath();
  const db = freshDb(path);
  const model = "opencode/qwen3.8-flash";
  const opened = new Date("2026-10-30T00:00:00.000Z");
  const after = new Date("2026-10-30T00:30:00.000Z"); // 30 min depois → level 1 (10 min) já vencido

  test("abre level 1 (10 min), depois de 30 min → half_open", () => {
    recordFailure(db, model, "timeout", opened);
    const open = breakerOf(db, model, opened);
    expect(open.state).toBe("open");
    expect(open.level).toBe(1);

    const expired = breakerOf(db, model, after);
    expect(expired.state).toBe("half_open");
    expect(expired.level).toBe(1);
    expect(expired.until).toBe(open.until);
  });

  test("level 3 (120 min) ainda dentro do prazo → open", () => {
    const path2 = tempDbPath();
    const db2 = freshDb(path2);
    const m = "opencode/deepseek-v4.1-flash-free";
    recordFailure(db2, m, "timeout", opened);
    recordFailure(db2, m, "timeout", opened);
    recordFailure(db2, m, "timeout", opened);
    const r = breakerOf(db2, m, after); // 30 min < 120 min
    expect(r.state).toBe("open");
    expect(r.level).toBe(3);
  });
});

describe("recordSuccess — zera o disjuntor", () => {
  test("após sucesso o state volta a closed, level 0, until null", () => {
    const path = tempDbPath();
    const db = freshDb(path);
    const model = "opencode/test-success";
    const now = new Date("2026-10-30T00:00:00.000Z");
    recordFailure(db, model, "timeout", now);
    expect(breakerOf(db, model, now).state).toBe("open");

    recordSuccess(db, model);
    const r = breakerOf(db, model, now);
    expect(r.state).toBe("closed");
    expect(r.level).toBe(0);
    expect(r.until).toBeNull();
  });

  test("recordSuccess em modelo sem histórico é noop", () => {
    const path = tempDbPath();
    const db = freshDb(path);
    expect(() => recordSuccess(db, "opencode/nunca-falhou")).not.toThrow();
  });
});

describe("consistência entre duas instâncias Database (mesmo arquivo)", () => {
  const path = tempDbPath();
  const now = new Date("2026-10-30T00:00:00.000Z");
  const model = "opencode/shared-model";

  test("recordFailure em db1 visível no db2", () => {
    const db1 = freshDb(path);
    recordFailure(db1, model, "timeout", now);
    db1.close();

    const db2 = new Database(path);
    db2.exec(TABLE_SCHEMA); // idempotente
    const r = breakerOf(db2, model, now);
    expect(r.state).toBe("open");
    expect(r.level).toBe(1);
    db2.close();
    unlinkSync(path);
  });

  test("breakerOf em db1 reflete recordFailure em db2", () => {
    const db1 = freshDb(path);
    const db2 = new Database(path);
    db2.exec(TABLE_SCHEMA);

    recordFailure(db2, model, "timeout", now);
    recordFailure(db2, model, "timeout", now);

    const r = breakerOf(db1, model, now);
    expect(r.level).toBe(2);
    db1.close();
    db2.close();
    unlinkSync(path);
  });
});
