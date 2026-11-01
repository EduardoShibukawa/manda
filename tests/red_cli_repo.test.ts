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

function setupMultiRepoCli(): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-cli-repo-")));
  roots.push(root);

  for (const repo of ["manda", "ginga"]) {
    const repoDir = join(root, repo);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "user.email", "test@test"]);
    put(join(repoDir, "README.md"), `# ${repo}\n`);
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "init"]);
  }

  const plan = "PLAN-0042-multi";
  const planDir = join(root, ".ginga", "plans", plan);

  put(
    join(planDir, "PLAN.md"),
    `---
type: plan
title: Multi-repo Demo
repos: [manda, ginga]
---
`,
  );

  put(
    join(planDir, "TASK-01-a.md"),
    `---
type: task
mode: mvp
goal: "manda task"
title: Tarefa manda
plan: PLAN-0042-multi
repo: manda
depends_on: []
tier: free
touch: [src/a.ts]
done_when: "bun test tests/frozen.test.ts"
tests_frozen: [tests/frozen.test.ts]
---
`,
  );

  put(
    join(planDir, "TASK-02-b.md"),
    `---
type: task
mode: mvp
goal: "ginga task"
title: Tarefa ginga
plan: PLAN-0042-multi
repo: ginga
depends_on: []
tier: free
touch: [src/b.ts]
done_when: "bun test tests/ginga.test.ts"
tests_frozen: [tests/ginga.test.ts]
---
`,
  );

  // frozen files for manda only
  put(
    join(planDir, "frozen", "manda", "tests", "frozen.test.ts"),
    `import { expect, test } from "bun:test";\ntest("manda ok", () => expect("red").toBe("green"));\n`,
  );

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

describe("manda red multi-repo pela CLI", () => {
  test("PLAN multi-repo: manda red --repo manda processa so TASKs do manda", () => {
    const { root, plan } = setupMultiRepoCli();
    fakePinga(root);

    const result = captureRun(["red", plan, "--repo", "manda", "--root", root]);

    expect(result.stderr).not.toContain("Unknown command");
    expect(result.code).toBe(0);

    const parsed = JSON.parse(result.stdout);
    // Only the manda task should be in the result
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].task).toBe("TASK-01-a");
    expect(parsed.tasks[0].red).toBe(true);

    // ginga task should not be mentioned
    expect(result.stdout).not.toContain("TASK-02-b");
  });
});
