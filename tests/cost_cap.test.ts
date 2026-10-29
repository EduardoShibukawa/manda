import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capCheck, spentUsd } from "../src/cost_cap.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "opencode-cost.sql");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDb(): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-cost-cap-")));
  dirs.push(dir);
  const path = join(dir, "opencode.db");
  const db = new Database(path, { create: true });
  for (const statement of readFileSync(FIXTURE, "utf8").split(";")) {
    const sql = statement.trim();
    if (sql) db.run(sql);
  }
  db.close();
  return path;
}

describe("spentUsd", () => {
  test("soma o custo do opencode.db e dos claude -p", () => {
    const path = fixtureDb();
    expect(spentUsd({ since: "2026-01-01T00:00:00.000Z", opencodeDb: path, claudeCosts: [0.40] })).toBeCloseTo(0.75, 8);
  });

  test("ignora sessões anterior a since e mantém o db somente leitura", () => {
    const path = fixtureDb();
    const db = new Database(path);
    db.run("INSERT INTO session_v2 (id, cost, time_created) VALUES ('ses-old', 9.00, 1767225599000)");
    db.close();
    chmodSync(path, 0o444);

    expect(spentUsd({ since: "2026-01-01T00:00:00.000Z", opencodeDb: path, claudeCosts: [] })).toBeCloseTo(0.35, 8);
  });
});

describe("capCheck", () => {
  test("nega quando a próxima chamada ultrapassa o teto", () => {
    const result = capCheck({ spent_usd: 0.75, next_estimate_usd: 0.30, cap_usd: 1.00 });
    expect(result.allow).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("permite uma chamada que cabe exatamente no teto", () => {
    expect(capCheck({ spent_usd: 0.75, next_estimate_usd: 0.25, cap_usd: 1.00 }).allow).toBe(true);
  });
});
