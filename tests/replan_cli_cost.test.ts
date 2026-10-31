import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

const savedPath = process.env.PATH;
const savedHome = process.env.HOME;
const savedFakeRoot = process.env.FAKE_ROOT;
const roots: string[] = [];

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedFakeRoot === undefined) delete process.env.FAKE_ROOT;
  else process.env.FAKE_ROOT = savedFakeRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
}

function put(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function setup(opts: { plannerLine: string; cap?: number }): { root: string; plan: string; task: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-replan-cost-")));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Manda Test"]);
  git(root, ["config", "user.email", "manda@example.test"]);
  put(join(root, "README.md"), "# manda\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "plan/0042"]);
  put(join(root, "CHANGE.md"), "mudanca do plano\n");
  git(root, ["add", "CHANGE.md"]);
  git(root, ["commit", "-m", "plan change"]);
  git(root, ["checkout", "main"]);

  const plan = "PLAN-0042-demo";
  const task = "TASK-03-replan";
  const planDir = join(root, ".ginga", "plans", plan);
  put(join(planDir, "PLAN.md"), "---\ntype: plan\ntitle: Demo\n---\n");
  put(join(planDir, `${task}.md`), "---\ntype: task\n---\n\ncorpo da tarefa\n");
  const toml =
    `[roles]\nplanner = "${opts.plannerLine}"\n` +
    (typeof opts.cap === "number" ? `\n[budget]\nround_usd = ${opts.cap}\n` : "");
  put(join(root, ".ginga", "project.toml"), toml);
  return { root, plan, task };
}

function fakeBin(root: string, name: string, body: string[]): void {
  const bin = join(root, "bin");
  put(join(bin, name), ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(join(bin, name), 0o755);
}

function fakePinga(root: string): void {
  fakeBin(root, "pinga", [
    'printf "%s\\n" "$*" >> "$FAKE_ROOT/pinga.log"',
    'if [ "$1" = "queue" ]; then printf \'{"tasks":[{"task":"T9","plan":"PLAN-0042-demo","receipt":{"reason_code":"quarto"}}]}\\n\'; exit 0; fi',
    "exit 2",
  ]);
  process.env.PATH = `${join(root, "bin")}:${savedPath ?? ""}`;
  process.env.FAKE_ROOT = root;
}

// ginga real não tem `cost --json`: só lint responde; o resto falha → fallback opencode.db+claudeCosts
function fakeGinga(root: string): void {
  fakeBin(root, "ginga", [
    'if [ "$1" = "lint" ]; then printf "ok\\n"; exit 0; fi',
    "exit 2",
  ]);
}

function fakeClaude(root: string, exitCode: number, stdoutLine: string): void {
  fakeBin(root, "claude", [
    'printf "%s\\n" "$*" > "$FAKE_ROOT/claude.args"',
    `printf '%s\\n' '${stdoutLine}'`,
    `exit ${exitCode}`,
  ]);
}

function fakeOpencode(root: string): void {
  fakeBin(root, "opencode", [
    'printf "%s\\n" "$*" > "$FAKE_ROOT/opencode.args"',
    'printf "fallback ok\\n"',
    "exit 0",
  ]);
}

// HOME temporário com opencode.db em <home>/.local/share/opencode/opencode.db
function fakeHomeWithDb(root: string, rows: Array<{ cost: number; ageMs: number }>): string {
  const home = join(root, "home");
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  put(dbPath, "");
  const db = new Database(dbPath);
  db.run("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, time_created INTEGER NOT NULL)");
  rows.forEach((r, i) => {
    db.run("INSERT INTO session_v2 (id, cost, time_created) VALUES (?, ?, ?)", [`ses-${i}`, r.cost, Date.now() - r.ageMs]);
  });
  db.close();
  process.env.HOME = home;
  return home;
}

function captureRun(args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => void stdout.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => void stderr.push(values.map(String).join(" "));
  try {
    const code = run(args);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

describe("manda replan: guarda de custo do planner na CLI", () => {
  test("gasto real de 24h no opencode.db bloqueia o planner pago ANTES de chamar o LLM", () => {
    const { root, plan, task } = setup({ plannerLine: "claude -p --model paid-pro", cap: 1.0 });
    fakePinga(root);
    fakeGinga(root);
    fakeClaude(root, 0, '{"type":"result","total_cost_usd":0.05}');
    fakeHomeWithDb(root, [{ cost: 0.9, ageMs: 60 * 60 * 1000 }]); // 0.90 gasto há 1h; 0.90+0.15 > 1.00

    const result = captureRun(["replan", plan, task, "--root", root]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).result).toBe("blocked");
    expect(existsSync(join(root, "claude.args"))).toBe(false); // planner não foi chamado
  });

  test("fallback do planner passa por NOVA checagem com o total_cost_usd do planner principal", () => {
    const { root, plan, task } = setup({ plannerLine: "claude -p --model paid-pro", cap: 1.0 });
    fakePinga(root);
    fakeGinga(root);
    fakeClaude(root, 1, '{"type":"result","is_error":true,"total_cost_usd":0.9}');
    fakeOpencode(root);
    fakeHomeWithDb(root, []); // sem gasto no db; o custo vem do total_cost_usd do claude

    const result = captureRun(["replan", plan, task, "--root", root]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).result).toBe("blocked");
    expect(existsSync(join(root, "opencode.args"))).toBe(false); // fallback não foi chamado: 0.90+0.15 > 1.00
  });

  test("modelo free não é barrado mesmo com gasto alto medido", () => {
    const { root, plan, task } = setup({ plannerLine: "claude -p --model beam-free", cap: 1.0 });
    fakePinga(root);
    fakeGinga(root);
    fakeClaude(root, 0, '{"type":"result","total_cost_usd":0.0}');
    fakeHomeWithDb(root, [{ cost: 5.0, ageMs: 60 * 60 * 1000 }]);

    const result = captureRun(["replan", plan, task, "--root", root]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("replanned");
    expect(existsSync(join(root, "claude.args"))).toBe(true);
  });

  test("dentro do teto o planner pago roda e o replan acontece", () => {
    const { root, plan, task } = setup({ plannerLine: "claude -p --model paid-pro", cap: 1.0 });
    fakePinga(root);
    fakeGinga(root);
    fakeClaude(root, 0, '{"type":"result","total_cost_usd":0.05}');
    fakeOpencode(root);
    fakeHomeWithDb(root, [{ cost: 0.1, ageMs: 60 * 60 * 1000 }]); // 0.10+0.15 <= 1.00

    const result = captureRun(["replan", plan, task, "--root", root]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe("replanned");
    expect(existsSync(join(root, "claude.args"))).toBe(true);
    expect(existsSync(join(root, "opencode.args"))).toBe(false);
  });

  test("extractTotalCostUsd devolve o último total_cost_usd do stream JSON", async () => {
    const mod = (await import("../src/cost_cap.ts")) as Record<string, unknown>;
    expect(typeof mod.extractTotalCostUsd).toBe("function");
    const extract = mod.extractTotalCostUsd as (s: string) => number | undefined;
    expect(
      extract('linha de texto\n{"type":"result","total_cost_usd":0.9}\n{"type":"result","total_cost_usd":0.42}\n'),
    ).toBe(0.42);
    expect(extract("sem json aqui")).toBeUndefined();
  });
});
