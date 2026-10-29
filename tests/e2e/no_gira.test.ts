import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * PLAN-0009 TASK-07: num repo git novo, sem `gira` nem `ginga` no PATH, INTENT vira PLAN e TASK (`manda plan`),
 * roda no pi (`manda run`) e passa no `pinga verify` real (ledger temporário). Os modelos são stubs no formato real.
 */
const ROOT = join(import.meta.dir, "..", "..");
const FIX = join(ROOT, "tests", "fixtures", "runtime");
const STUBS = join(import.meta.dir, "stubs");
const PINGA = process.env.PINGA_BIN ?? Bun.which("pinga") ?? "pinga";

let ws: string;
let aux: string;
let bin: string;
let ledger: string;
let log: string;

function sh(cwd: string, ...a: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
}
function put(rel: string, text: string) {
  const p = join(ws, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const text = (s: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: s }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } }, stopReason: "stop" } }) + "\n";

const PLAN_ID = "PLAN-0001-x";
const PLANNER_REPLY = [
  "=== FILE: PLAN.md ===",
  '---\ntype: plan\ntitle: x\nstatus: approved\ndone_when: "test -f src/a.ts"\n---\n## Objetivo\ncriar src/a.ts',
  "=== FILE: TASK-01-a.md ===",
  `---\ntype: task\nmode: mvp\ngoal: "cria src/a.ts"\nplan: ${PLAN_ID}\ndepends_on: []\ntier: free\ntouch: [src/a.ts]\ndone_when: "test -f src/a.ts"\ntests_frozen: []\n---\n## Fazer\n- criar src/a.ts`,
].join("\n");

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-nogira-")));
  aux = realpathSync(mkdtempSync(join(tmpdir(), "manda-nogira-aux-")));
  bin = join(aux, "bin");
  mkdirSync(bin);
  ledger = join(aux, "ledger.db");
  log = join(aux, "calls.log");
  symlinkSync(join(STUBS, "pi"), join(bin, "pi"));
  symlinkSync(PINGA, join(bin, "pinga"));
  writeFileSync(join(aux, "planner.jsonl"), text(PLANNER_REPLY));
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
  put(".ginga/intents/INTENT-0001-x.md", "---\ntype: intent\ntitle: x\n---\nQUERO um src/a.ts\n");
  put(
    ".ginga/project.toml",
    [
      '[runtimes]\nplanner = "pi:opencode/glm-5.3-flash-free"',
      '[runtimes.tier]\nfree = "pi"',
      '[context]\nprovider = "rg"',
      `[commands]\nverify = "pinga verify tasks/T1/PLAN.md --root {worktree} --ledger ${ledger}"`,
    ].join("\n\n") + "\n",
  );
  put("tasks/T1/PLAN.md", '---\nmode: mvp\ngoal: "cria src/a.ts"\ndone_when: "test -f src/a.ts"\ntouch: ["src/a.ts"]\n---\n');
  sh(ws, "add", ".");
  sh(ws, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

// PATH só com os stubs, o bun e as ferramentas do sistema: sem ~/.local/bin (onde moram gira e ginga)
const env = () => ({
  ...process.env,
  PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  STUB_LOG: log,
  STUB_PLANNER_OUT: join(aux, "planner.jsonl"),
  STUB_EXEC_OUT: join(FIX, "pi-ok.jsonl"),
});
function manda(...args: string[]) {
  return Bun.spawnSync([process.execPath, join(ROOT, "bin/manda.ts"), ...args, "--root", ws], { cwd: ROOT, env: env(), stdout: "pipe", stderr: "pipe" });
}

describe("INTENT → PLAN → TASK → verify, sem gira nem ginga", () => {
  test("o PATH do teste não resolve gira nem ginga", () => {
    const r = Bun.spawnSync(["sh", "-c", "command -v gira; command -v ginga"], { env: env(), stdout: "pipe" });
    expect(r.stdout.toString().trim()).toBe("");
  });

  test("manda plan grava o PLAN e a TASK a partir do INTENT", () => {
    const r = manda("plan", "INTENT-0001");
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(ws, ".ginga/plans/PLAN-0001-x")).sort()).toEqual(["PLAN.md", "TASK-01-a.md"]);
  });

  test("manda run executa no pi e o pinga verify real sela receipt pass no ledger temporário", () => {
    expect(manda("plan", "INTENT-0001").exitCode).toBe(0);
    const r = manda("run", PLAN_ID);
    expect(r.stderr.toString()).not.toContain("gira");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(true);
    // uma invocação por linha que começa com o cwd; o prompt multilinha continua nas linhas seguintes
    const calls = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("\t--no-session --mode json"));
    expect(calls.length).toBe(2); // planner + executor
    const q = Bun.spawnSync([PINGA, "queue", "--json", "--root", ws, "--ledger", ledger], { env: env(), stdout: "pipe", stderr: "pipe" });
    const t1 = JSON.parse(q.stdout.toString()).tasks.find((t: any) => t.task === "T1");
    expect(t1.state).toBe("done");
    expect(t1.receipt.status).toBe("pass");
  });
});
