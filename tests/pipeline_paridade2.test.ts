import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { main, runPipeline } from "../src/pipeline";

const scratch: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  process.env.PATH = savedPath;
  delete process.env.MANDA_PIPELINE_SKIP_OPERATOR;
});

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

function makeFixture(toml?: string) {
  const tmp = mkdtempSync(join(tmpdir(), "p2-"));
  scratch.push(tmp);
  const repo = join(tmp, "manda");
  mkdirSync(repo);
  sh(repo, "git init -b main");
  sh(repo, "git config user.email t@t.com");
  sh(repo, "git config user.name t");
  writeFileSync(join(repo, "README.md"), "x");
  sh(repo, "git add . && git commit -m init");
  const ginga = join(tmp, ".ginga");
  mkdirSync(join(ginga, "prompts"), { recursive: true });
  mkdirSync(join(ginga, "handoffs"), { recursive: true });
  writeFileSync(join(ginga, "prompts", "op-base.md"), "OPBASE");
  writeFileSync(join(ginga, "prompts", "backlog-manda.md"), "- [ ] item\n");
  if (toml !== undefined) writeFileSync(join(ginga, "project.toml"), toml);
  return { tmp, repo, ginga };
}

/** instala um executável falso `name` no PATH com o corpo `body` (bash). */
function fakeBin(tmp: string, name: string, body: string) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, name);
  writeFileSync(script, "#!/usr/bin/env bash\n" + body + "\n");
  chmodSync(script, 0o755);
  process.env.PATH = bin + ":" + savedPath;
}

describe("(a) operador claude/<modelo>", () => {
  test("claude/x roda `claude -p --model x ...` com timeout, não opencode", async () => {
    const { tmp, repo } = makeFixture('[supervisor]\nmodels = ["claude/x"]\n');
    const argv = join(tmp, "argv");
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/usr/bin/env bash\necho opencode >> " + join(tmp, "oc") + "\n");
    chmodSync(join(bin, "opencode"), 0o755);
    fakeBin(tmp, "claude", `printf '%s\\n' "$@" > "${argv}"; touch "${repo}/feito.txt"`);
    await runPipeline({ repo: "manda", root: tmp, rounds: 1, idleThresholdMs: 5000, pollMs: 50 });
    const args = readFileSync(argv, "utf8").split("\n");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("x");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toMatch(/^lane:lane-manda-/);
    expect(args.join("\n")).toContain("OPBASE");
    expect(existsSync(join(tmp, "oc"))).toBe(false);
    expect(existsSync(join(tmp, ".ginga", "handoffs")) && readFileSync(join(tmp, "argv"), "utf8").length > 0).toBe(true);
  }, 30000);

  test("claude/<modelo> parado sem progresso é morto pelo pid", async () => {
    const { tmp } = makeFixture('[supervisor]\nmodels = ["claude/x"]\n');
    fakeBin(tmp, "claude", "sleep 300");
    const t0 = Date.now();
    await runPipeline({ repo: "manda", root: tmp, rounds: 1, idleThresholdMs: 300, pollMs: 50 });
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 30000);
});

describe("(b) operator_models / executor_models / [supervisor.env]", () => {
  test("o ambiente do operador tem MODELS, ALLOW_PAID, SPEND_FILE e TOTAL_CAP do project.toml", async () => {
    const toml = [
      "[supervisor]",
      'models = ["m/ignorado"]',
      'operator_models = ["op/um"]',
      'executor_models = ["ex/a", "ex/b"]',
      "[supervisor.env]",
      "ALLOW_PAID = 1",
      'SPEND_FILE = "/tmp/spend.tsv"',
      "TOTAL_CAP = 1.8",
      "",
    ].join("\n");
    const { tmp, repo } = makeFixture(toml);
    const out = join(tmp, "env.out");
    fakeBin(tmp, "opencode", `echo "MODELS=$MODELS" > "${out}"; echo "ALLOW_PAID=$ALLOW_PAID" >> "${out}"; echo "SPEND_FILE=$SPEND_FILE" >> "${out}"; echo "TOTAL_CAP=$TOTAL_CAP" >> "${out}"; echo "ARGS=$*" | cut -c1-80 >> "${out}"; touch "${repo}/feito.txt"`);
    const saved = process.env.MODELS;
    process.env.MODELS = "herdado/errado";
    await runPipeline({ repo: "manda", root: tmp, rounds: 1, idleThresholdMs: 5000, pollMs: 50 });
    if (saved === undefined) delete process.env.MODELS;
    else process.env.MODELS = saved;
    const env = readFileSync(out, "utf8");
    expect(env).toContain("MODELS=ex/a ex/b");
    expect(env).toContain("ALLOW_PAID=1");
    expect(env).toContain("SPEND_FILE=/tmp/spend.tsv");
    expect(env).toContain("TOTAL_CAP=1.8");
    expect(env).toContain("-m op/um");
  }, 30000);

  test("sem operator_models cai em models; sem executor_models o MODELS do ambiente some", async () => {
    const { tmp, repo } = makeFixture('[supervisor]\nmodels = ["m/um"]\n');
    const out = join(tmp, "env.out");
    fakeBin(tmp, "opencode", `echo "MODELS=[$MODELS]" > "${out}"; echo "ARGS=$*" | cut -c1-80 >> "${out}"; touch "${repo}/feito.txt"`);
    const saved = process.env.MODELS;
    process.env.MODELS = "herdado/errado";
    await runPipeline({ repo: "manda", root: tmp, rounds: 1, idleThresholdMs: 5000, pollMs: 50 });
    if (saved === undefined) delete process.env.MODELS;
    else process.env.MODELS = saved;
    const env = readFileSync(out, "utf8");
    expect(env).toContain("MODELS=[]");
    expect(env).toContain("-m m/um");
  }, 30000);
});

describe("(c) cota free esgotada", () => {
  test("log curto com 'free usage limit' → repete a rodada com o próximo modelo", async () => {
    const { tmp, repo } = makeFixture('[supervisor]\nmodels = ["m/um", "m/dois"]\n');
    const calls = join(tmp, "calls");
    writeFileSync(calls, "");
    fakeBin(
      tmp,
      "opencode",
      `while [ $# -gt 0 ]; do [ "$1" = "-m" ] && echo "$2" >> "${calls}"; shift; done
if [ "$(wc -l < "${calls}")" = 1 ]; then echo "Error: free usage limit reached"; else touch "${repo}/feito.txt"; fi`,
    );
    const res = await runPipeline({ repo: "manda", root: tmp, rounds: 3, idleThresholdMs: 5000, pollMs: 50 });
    expect(readFileSync(calls, "utf8").trim().split("\n").slice(0, 2)).toEqual(["m/um", "m/dois"]);
    expect(res.exitCode).not.toBe(4);
    expect(existsSync(join(tmp, ".ginga", "handoffs", ".free-esgotado"))).toBe(false);
  }, 30000);

  test("todos os modelos sem cota → exit 4 e handoffs/.free-esgotado", async () => {
    const { tmp } = makeFixture('[supervisor]\nmodels = ["m/um", "m/dois"]\n');
    fakeBin(tmp, "opencode", 'echo "Error: quota exceeded"');
    const res = await runPipeline({ repo: "manda", root: tmp, rounds: 5, idleThresholdMs: 5000, pollMs: 50 });
    expect(res.exitCode).toBe(4);
    expect(existsSync(join(tmp, ".ginga", "handoffs", ".free-esgotado"))).toBe(true);
  }, 30000);

  test("log grande que cita o texto da cota é trabalho real, não cota esgotada", async () => {
    const { tmp } = makeFixture('[supervisor]\nmodels = ["m/um"]\n');
    fakeBin(tmp, "opencode", 'echo "quota exceeded"; head -c 7000 /dev/zero | tr "\\0" "a"; echo');
    const res = await runPipeline({ repo: "manda", root: tmp, rounds: 1, idleThresholdMs: 5000, pollMs: 50 });
    expect(res.exitCode).not.toBe(4);
    expect(existsSync(join(tmp, ".ginga", "handoffs", ".free-esgotado"))).toBe(false);
  }, 30000);
});

describe("(d) rodada sem progresso", () => {
  test("rodada que não muda nada com pendência → exit 3", async () => {
    const { tmp } = makeFixture();
    const res = await runPipeline({ repo: "manda", root: tmp, rounds: 3, skipOperator: true, idleThresholdMs: 1000, pollMs: 10 });
    expect(res.exitCode).toBe(3);
    expect(res.rounds).toBe(1);
  }, 30000);

  test("rodada em que o operador marca o backlog não é sem progresso", async () => {
    const { tmp, ginga } = makeFixture();
    fakeBin(tmp, "opencode", `echo "- [x] item" > "${join(ginga, "prompts", "backlog-manda.md")}"`);
    const res = await runPipeline({ repo: "manda", root: tmp, rounds: 3, idleThresholdMs: 5000, pollMs: 50 });
    expect(res.exitCode).toBe(0);
  }, 30000);
});

describe("(e) manda lane <repo> [rodadas]", () => {
  test("a contagem posicional limita as rodadas", async () => {
    const { tmp, ginga } = makeFixture();
    const events = join(tmp, "events.jsonl");
    process.env.GINGA_EVENTS = events;
    process.env.MANDA_FORCE_CONTINUE = "1";
    process.env.MANDA_PIPELINE_SKIP_OPERATOR = "1";
    const code = await main(["lane", "manda", "2", "--root", tmp]);
    delete process.env.GINGA_EVENTS;
    delete process.env.MANDA_FORCE_CONTINUE;
    const starts = readFileSync(events, "utf8")
      .split("\n")
      .filter((l) => l.includes('"start"')).length;
    expect(code).toBe(0);
    expect(starts).toBe(2);
    expect(existsSync(ginga)).toBe(true);
  }, 30000);
});
