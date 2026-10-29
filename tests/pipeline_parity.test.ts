import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  buildRoundPrompt,
  runPipeline,
  hasRealProgress,
  killByPid,
} from "../src/pipeline";

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "pp-"));
  const repo = join(tmp, "manda");
  mkdirSync(repo);
  sh(repo, "git init -b main");
  sh(repo, "git config user.email t@t.com");
  sh(repo, "git config user.name t");
  writeFileSync(join(repo, "README.md"), "x");
  sh(repo, "git add . && git commit -m init");

  const ginga = join(tmp, ".ginga");
  mkdirSync(join(ginga, "plans", "PLAN-X", "ready"), { recursive: true });
  mkdirSync(join(ginga, "prompts"), { recursive: true });
  mkdirSync(join(ginga, "handoffs"), { recursive: true });
  writeFileSync(join(ginga, "prompts", "op-base.md"), "OPBASE_MARKER");
  writeFileSync(
    join(ginga, "plans", "PLAN-X", "ready", "manda.json"),
    JSON.stringify({ branch: "plan/x" }),
  );
  mkdirSync(join(ginga, "plans", "PLAN-X", "judge"), { recursive: true });
  writeFileSync(
    join(ginga, "plans", "PLAN-X", "judge", "manda.json"),
    JSON.stringify({
      head: "abc",
      judge: { items: [{ ref: "TASK-99", ok: false, regression: false, evidence: "ev" }] },
    }),
  );
  writeFileSync(join(ginga, "plans", "PLAN-X", "log.md"), "line1\ngate: last line\n");
  writeFileSync(join(ginga, "prompts", "backlog-manda.md"), "- [ ] backlog item\n");
  return { tmp, repo, ginga };
}

describe("pipeline parity", () => {
  test("(a) buildRoundPrompt inclui op-base, judge nao-ok, ultima linha do gate e backlog", () => {
    const { tmp } = makeFixture();
    const r = buildRoundPrompt(tmp, "manda", 1, "lane-manda-test-r1");
    expect(r.content).toContain("OPBASE_MARKER");
    expect(r.content).toContain("TASK-99");
    expect(r.content).toContain("gate: last line");
    expect(r.content).toContain("backlog item");
    expect(existsSync(r.path)).toBe(true);
  });

  test("(d) heartbeat.progress e efeito real, nao numero da rodada", async () => {
    const { tmp } = makeFixture();
    const eventsFile = join(tmp, "events.jsonl");
    process.env.GINGA_EVENTS = eventsFile;
    const res = await runPipeline({
      repo: "manda",
      root: tmp,
      rounds: 1,
      skipOperator: true,
      idleThresholdMs: 1000,
      pollMs: 10,
    });
    delete process.env.GINGA_EVENTS;
    expect(res.rounds).toBe(1);
    expect(res.progress).not.toBe(res.rounds);
    const text = existsSync(eventsFile) ? await Bun.file(eventsFile).text() : "";
    expect(text).toContain("heartbeat");
  });

  test("(c) aborta com exit 20 se main mudar durante o operador", async () => {
    const { tmp, repo } = makeFixture();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "opencode");
    writeFileSync(script, "#!/usr/bin/env bash\ncd " + repo + " && git commit --allow-empty -m moved --quiet 2>/dev/null || true\nexit 0\n");
    sh(tmp, "chmod +x " + script);
    const prevPath = process.env.PATH;
    process.env.PATH = bin + ":" + prevPath;
    const res = await runPipeline({
      repo: "manda",
      root: tmp,
      rounds: 1,
      idleThresholdMs: 1000,
      pollMs: 10,
    });
    process.env.PATH = prevPath as string;
    expect(res.exitCode).toBe(20);
  });

  test("(b) vigia mata operador por pid apos sem progresso", async () => {
    const { tmp } = makeFixture();
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "opencode");
    writeFileSync(script, "#!/usr/bin/env bash\nsleep 300\n");
    sh(tmp, "chmod +x " + script);
    const prevPath = process.env.PATH;
    process.env.PATH = bin + ":" + prevPath;
    const start = Date.now();
    const res = await runPipeline({
      repo: "manda",
      root: tmp,
      rounds: 1,
      idleThresholdMs: 200,
      pollMs: 50,
    });
    process.env.PATH = prevPath as string;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test("hasRealProgress detecta saida nao-build", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hpp-"));
    const log = join(tmp, "x.log");
    writeFileSync(log, "> build\nreal output\n");
    const r = hasRealProgress(log, [], 0);
    expect(r.changed).toBe(true);
  });

  test("killByPid mata processo", () => {
    const proc = Bun.spawn(["sleep", "300"], { stdout: "pipe", stderr: "pipe" });
    const ok = killByPid(proc.pid);
    expect(ok).toBe(true);
  });
});
