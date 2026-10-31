import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { breakerOf, recordSuccess, type BreakerState } from "./breaker";
import { emitEvent } from "./events";

export type BreakerStatusEntry = {
  model: string;
  state: BreakerState;
  until: string | null;
  level: number;
  last_reason: string | null;
};

type BreakerRow = {
  model: string;
  level: number;
  until: string | null;
  last_reason: string | null;
};

/** Lista o estado de todos os modelos registrados no disjuntor. */
export function breakerStatus(db: Database, now: Date): BreakerStatusEntry[] {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_breaker'")
    .get();
  if (!table) return [];

  const rows = db
    .query(
      "SELECT model, level, until, last_reason FROM model_breaker ORDER BY model",
    )
    .all() as BreakerRow[];

  return rows.map((row) => {
    const info = breakerOf(db, row.model, now);
    return {
      model: row.model,
      state: info.state,
      until: info.until,
      level: info.level,
      last_reason: row.last_reason ?? null,
    };
  });
}

/** Fecha manualmente o disjuntor de um modelo e registra a transição. */
export function breakerReset(db: Database, model: string): void {
  recordSuccess(db, model);
  emitEvent("transition", {
    entity: "breaker",
    model,
    from: "open",
    to: "closed",
    by: "owner",
    via: "cli",
  });
}

/** Caminho do state.db compartilhado; o ambiente vence para permitir isolamento. */
export function breakerStateDbPath(): string {
  const configured = process.env.GINGA_STATE_DB;
  if (configured && configured !== "") return configured;
  return join(process.cwd(), ".ginga", "state", "state.db");
}

function openBreakerDb(): Database {
  const path = breakerStateDbPath();
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

function breakerUsage(): number {
  console.error("Usage: manda breaker status [--json]\n       manda breaker reset <modelo>");
  return 2;
}

/** Implementa `manda breaker status|reset`. */
export function breakerMain(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return breakerUsage();

  const db = openBreakerDb();
  try {
    if (subcommand === "status") {
      const status = breakerStatus(db, new Date());
      if (rest.includes("--json")) {
        console.log(JSON.stringify(status));
      } else {
        for (const entry of status) {
          console.log(
            [
              entry.model,
              entry.state,
              entry.until ?? "-",
              entry.level,
              entry.last_reason ?? "-",
            ].join("\t"),
          );
        }
      }
      return 0;
    }

    if (subcommand === "reset") {
      const model = rest[0];
      if (model === undefined || model === "") return breakerUsage();
      breakerReset(db, model);
      return 0;
    }

    return breakerUsage();
  } finally {
    db.close();
  }
}
