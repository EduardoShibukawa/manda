import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { loadSupervisorModels, runPipeline } from "../src/pipeline";

const scratch: string[] = [];
const savedEnv = { PATH: process.env.PATH, FORCE: process.env.MANDA_FORCE_CONTINUE, REPO: process.env.FIXTURE_REPO };
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  process.env.PATH = savedEnv.PATH;
  if (savedEnv.FORCE === undefined) delete process.env.MANDA_FORCE_CONTINUE;
  else process.env.MANDA_FORCE_CONTINUE = savedEnv.FORCE;
  if (savedEnv.REPO === undefined) delete process.env.FIXTURE_REPO;
  else process.env.FIXTURE_REPO = savedEnv.REPO;
});

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

function makeFixture(toml?: string) {
  const tmp = mkdtempSync(join(tmpdir(), "pv-"));
  scratch.push(tmp);
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
  writeFileSync(join(ginga, "prompts", "op-base.md"), "OPBASE");
  writeFileSync(join(ginga, "plans", "PLAN-X", "ready", "manda.json"), JSON.stringify({ branch: "plan/x" }));
  writeFileSync(join(ginga, "prompts", "backlog-manda.md"), "- [ ] item\n");
  if (toml !== undefined) writeFileSync(join(ginga, "project.toml"), toml);
  return { tmp, repo };
}

/** `opencode` falso: registra o -m, e na 1ª chamada toca 1 arquivo no repo e dorme 8 s; nas demais sai logo. */
function fakeOpencode(tmp: string, repo: string) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(tmp, "calls");
  const script = join(bin, "opencode");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = "-m" ] && echo "$2" >> "${calls}"; shift; done
if [ "$(wc -l < "${calls}")" = 1 ]; then touch "$FIXTURE_REPO/once.txt"; sleep 8; fi
`,
  );
  chmodSync(script, 0o755);
  process.env.PATH = bin + ":" + savedEnv.PATH;
  process.env.FIXTURE_REPO = repo;
  return calls;
}

describe("loadSupervisorModels: [supervisor] models do project.toml", () => {
  test("lê models do toml", () => {
    const { tmp } = makeFixture('[supervisor]\nmodels = ["m/one", "m/two"]\n');
    expect(loadSupervisorModels(tmp)).toEqual(["m/one", "m/two"]);
  });

  test("sem toml ou sem [supervisor] → padrão glm-5.3-flash-free, beam-free", () => {
    const { tmp } = makeFixture();
    const padrao = ["opencode/glm-5.3-flash-free", "opencode-go/beam-free"];
    expect(loadSupervisorModels(tmp)).toEqual(padrao);
    const { tmp: tmp2 } = makeFixture("[outra]\nx = 1\n");
    expect(loadSupervisorModels(tmp2)).toEqual(padrao);
  });
});

describe("vigia de progresso por tick", () => {
  test("1 arquivo alterado no início e nada depois → morto pelo ocioso, e o modelo gira para o 2º do toml", async () => {
    const { tmp, repo } = makeFixture('[supervisor]\nmodels = ["m/one", "m/two"]\n');
    const calls = fakeOpencode(tmp, repo);
    writeFileSync(calls, "");
    process.env.MANDA_FORCE_CONTINUE = "1";
    const t0 = Date.now();
    await runPipeline({ repo: "manda", root: tmp, rounds: 2, idleThresholdMs: 600, pollMs: 100 });
    const elapsed = Date.now() - t0;
    // sem o fix, a mudança única (mais nova que o início da rodada) zera o ocioso para sempre e o operador roda os 8 s inteiros
    expect(elapsed).toBeLessThan(5000);
    expect(existsSync(join(repo, "once.txt"))).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["m/one", "m/two"]);
  }, 30000);
});
