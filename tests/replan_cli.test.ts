import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

const savedPath = process.env.PATH;
const savedFakeRoot = process.env.FAKE_ROOT;
const roots: string[] = [];

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
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

function setup(): { root: string; plan: string; task: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-replan-cli-")));
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
  put(join(planDir, "LEARNINGS.md"), "- learning estável\n");
  put(join(planDir, "judge", "manda.json"), JSON.stringify({ items: [{ ref: "TASK-03", ok: false, evidence: "achado alto" }] }));
  put(join(root, ".ginga", "project.toml"), '[roles]\nplanner = "claude -p --model test-model"\n');
  return { root, plan, task };
}

function fakePinga(root: string): void {
  const bin = join(root, "bin");
  put(
    join(bin, "pinga"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_ROOT/pinga.log"',
      'if [ "$1" = "queue" ]; then printf \'{"tasks":[{"task":"T9","plan":"PLAN-0042-demo","receipt":{"reason_code":"quarto"}}]}\\n\'; exit 0; fi',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pinga"), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.FAKE_ROOT = root;
}

function fakeClaude(root: string): void {
  const bin = join(root, "bin");
  put(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" > "$FAKE_ROOT/claude.args"',
      'printf "PLAN reescrito\\n"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "claude"), 0o755);
}

function fakeGinga(root: string): void {
  const bin = join(root, "bin");
  put(
    join(bin, "ginga"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_ROOT/ginga.log"',
      'if [ "$1" = "lint" ]; then printf "ok\\n"; exit 0; fi',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "ginga"), 0o755);
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

describe("manda replan pela CLI", () => {
  test("monta contexto real e chama o Planner configurado", () => {
    const { root, plan, task } = setup();
    fakePinga(root);
    fakeClaude(root);
    fakeGinga(root);

    const result = captureRun(["replan", plan, task, "--root", root]);

    expect(result.stderr).not.toContain("Unknown command");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.result).toBe("replanned");

    const pingaCalls = readFileSync(join(root, "pinga.log"), "utf8");
    expect(pingaCalls).toContain("queue");
    expect(pingaCalls).toContain("--json");

    const gingaCalls = readFileSync(join(root, "ginga.log"), "utf8");
    expect(gingaCalls).toContain("lint");

    const claudeArgs = readFileSync(join(root, "claude.args"), "utf8");
    expect(claudeArgs).toContain("corpo da tarefa");
    expect(claudeArgs).toContain("quarto");
    expect(claudeArgs).toContain("achado alto");
    expect(claudeArgs).toContain("learning estável");
    expect(claudeArgs).toContain("CHANGE.md");
  });
});
