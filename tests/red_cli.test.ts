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
import { redPlan, type Runner } from "../src/red.ts";

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

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
  return result.stdout.toString();
}

function put(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function setup(withMissingFrozen = false): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-cli-")));
  roots.push(root);
  const repo = join(root, "manda");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Manda Test"]);
  git(repo, ["config", "user.email", "manda@example.test"]);
  put(join(repo, "README.md"), "# manda\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);

  const plan = "PLAN-0042-demo";
  const planDir = join(root, ".ginga", "plans", plan);
  const frozen = withMissingFrozen
    ? "tests/frozen.test.ts, tests/missing.test.ts"
    : "tests/frozen.test.ts";
  put(
    join(planDir, "TASK-01-a.md"),
    [
      "---",
      "type: task",
      "mode: padrao",
      'goal: "materializar RED"',
      "repo: manda",
      "depends_on: []",
      "tier: medium",
      "touch: [tests/frozen.test.ts]",
      'done_when: "bun test tests/frozen.test.ts"',
      `tests_frozen: [${frozen}]`,
      "---",
      "## Fazer",
      "- materializar RED",
      "",
    ].join("\n"),
  );
  put(join(planDir, "frozen", "manda", "tests", "frozen.test.ts"), "test('frozen', () => {});\n");
  return { root, plan };
}

function fakePinga(root: string): void {
  const bin = join(root, "bin");
  put(
    join(bin, "pinga"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_ROOT/pinga.log"',
      'if [ "$1" = "queue" ]; then',
      '  case " $* " in *" --json "*) printf \'{"tasks":[{"task":"T7","state":"done"}]}\\n\' ;; *) printf "T7\\n" ;; esac',
      "  exit 0",
      "fi",
      'if [ "$1" = "prove-red" ]; then printf "RED provado\\n"; exit 0; fi',
      "exit 2",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pinga"), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.FAKE_ROOT = root;
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

describe("manda red pela CLI", () => {
  test("executa redPlan, consulta a fila em JSON e materializa o RED", () => {
    const { root, plan } = setup();
    fakePinga(root);

    const result = captureRun(["red", plan, "--repo", "manda", "--root", root]);

    expect(result.stderr).not.toContain("Unknown command");
    expect(result.code).toBe(0);
    const calls = readFileSync(join(root, "pinga.log"), "utf8");
    expect(calls).toContain("queue");
    expect(calls).toContain("--json");
    expect(calls).toContain("prove-red");
    expect(existsSync(join(root, "manda-plan-0042", "tasks", "T8", "PLAN.md"))).toBe(true);
  });

  test("reprova com o caminho quando um tests_frozen individual não existe", () => {
    const { root, plan } = setup(true);
    const pinga: Runner = (argv) => {
      if (argv[0] === "queue") {
        return { code: 0, stdout: JSON.stringify({ tasks: [{ task: "T7", state: "done" }] }) };
      }
      return { code: 0, stdout: "RED provado" };
    };
    const gitRunner: Runner = (argv, cwd) => {
      const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };

    expect(() => redPlan({ root, plan, repo: "manda", pinga, git: gitRunner })).toThrow(
      /tests\/missing\.test\.ts/,
    );
  });
});
