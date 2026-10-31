import { Database } from "bun:sqlite";

/** Estados do disjuntor de circuito por modelo (PLAN-0029 TASK-03). */
export type BreakerState = "closed" | "open" | "half_open";

export type BreakerInfo = {
  state: BreakerState;
  until: string | null;
  level: number;
};

/** Duração (min) por nível de disjuntor: 1→10, 2→30, 3→120. */
const DURATIONS_MIN = [10, 30, 120] as const;
const MAX_LEVEL = 3;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS model_breaker (
    model TEXT PRIMARY KEY,
    level INTEGER DEFAULT 0,
    opened_at TEXT,
    until TEXT,
    last_reason TEXT
  )
`;

/** Garante que a tabela existe (noop se já criada pelo caller). */
function ensureTable(db: Database): void {
  db.exec(TABLE_DDL);
}

/** Estado atual do disjuntor para um modelo. */
export function breakerOf(db: Database, model: string, now: Date): BreakerInfo {
  ensureTable(db);
  const row = db
    .query("SELECT level, until FROM model_breaker WHERE model = ?")
    .get(model) as { level: number; until: string } | null;

  if (!row || row.level === 0) {
    return { state: "closed", until: null, level: 0 };
  }

  const untilMs = row.until ? new Date(row.until).getTime() : 0;
  if (now.getTime() > untilMs) {
    return { state: "half_open", until: row.until, level: row.level };
  }
  return { state: "open", until: row.until, level: row.level };
}

/** Registra uma falha: incrementa o nível (máx. 3) e estende `until`. */
export function recordFailure(
  db: Database,
  model: string,
  reason: string,
  now: Date,
): void {
  ensureTable(db);
  const current = db
    .query("SELECT level FROM model_breaker WHERE model = ?")
    .get(model) as { level: number } | null;

  const newLevel = Math.min((current?.level ?? 0) + 1, MAX_LEVEL);
  const durationMs = DURATIONS_MIN[newLevel - 1] * 60_000;
  const until = new Date(now.getTime() + durationMs).toISOString();

  db.prepare(
    `INSERT INTO model_breaker (model, level, opened_at, until, last_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       level = excluded.level,
       opened_at = excluded.opened_at,
       until = excluded.until,
       last_reason = excluded.last_reason`,
  ).run(model, newLevel, now.toISOString(), until, reason);
}

/** Zera o disjuntor (sucesso): remove a linha do modelo. */
export function recordSuccess(db: Database, model: string): void {
  ensureTable(db);
  db.prepare("DELETE FROM model_breaker WHERE model = ?").run(model);
}
