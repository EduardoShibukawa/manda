import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { findLlmAgent, type LlmAgentCheck } from "./llm_guard";

export interface JudgeRunOptions {
  plan: string;
  repo: string;
  branch: string;
  repoName?: string;
  root?: string;
  forceRejudge?: boolean;
  codexBin?: string;
  env?: Record<string, string>;
  parentPid?: number;
  skipAgentCheck?: boolean;
}

export interface JudgeRunResult {
  exitCode: number;
  why?: string;
  reused?: boolean;
  head?: string;
  judgePath?: string;
  logPath?: string;
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isoLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export type { LlmAgentCheck };

/** Reexportado de llm_guard (T101): comportamento idêntico ao original. */
export function insideLlmAgent(startPid: number = process.ppid): LlmAgentCheck {
  return findLlmAgent(startPid);
}

function resolveRepo(repo: string, root: string): string {
  if (isAbsolute(repo)) return repo;
  const fromCwd = join(process.cwd(), repo);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = join(root, repo);
  if (existsSync(fromRoot)) return fromRoot;
  return fromCwd;
}

function resolvePlan(plan: string): string {
  if (isAbsolute(plan)) return plan;
  return join(process.cwd(), plan);
}

function gitSpawn(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

function findWorktree(repoPath: string, branch: string): string {
  const r = gitSpawn(["worktree", "list", "--porcelain"], repoPath);
  const lines = r.stdout.toString().split("\n");
  let last = "";
  for (const line of lines) {
    if (line.startsWith("worktree ")) last = line.slice("worktree ".length).trim();
    else if (line === `branch refs/heads/${branch}`) return last;
  }
  return "";
}

export async function runJudge(opts: JudgeRunOptions): Promise<JudgeRunResult> {
  const root = opts.root ?? process.cwd();
  const plan = resolvePlan(opts.plan);
  const repoPath = resolveRepo(opts.repo, root);
  const branch = opts.branch;
  const repoName = opts.repoName ?? basename(repoPath);

  // recusa se chamado de dentro de um agente LLM
  if (!opts.skipAgentCheck) {
    const check = insideLlmAgent(opts.parentPid ?? process.ppid);
    if (check.refused) {
      const msg = `{"error":"recusado: chamado de dentro de um agente LLM (pid ${check.pid}: ${check.label}); só o pipeline.sh pode"}`;
      console.log(msg);
      return { exitCode: 30, why: msg };
    }
  }

  const wt = findWorktree(repoPath, branch);
  if (!wt) {
    const msg = `{"error":"sem worktree para ${branch} em ${repoPath}"}`;
    console.log(msg);
    return { exitCode: 2, why: msg };
  }

  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();

  const judgeDir = join(plan, "judge");
  const verdictPath = join(judgeDir, `${repoName}.json`);
  const force = opts.forceRejudge || process.env.FORCE_REJUDGE === "1";

  // um veredito por HEAD
  if (existsSync(verdictPath) && !force) {
    try {
      const parsed = JSON.parse(readFileSync(verdictPath, "utf8"));
      if (parsed && typeof parsed === "object" && (parsed as { head?: unknown }).head === head) {
        console.log(JSON.stringify({ judge: verdictPath, head, reused: true }));
        return { exitCode: 0, reused: true, head, judgePath: verdictPath };
      }
    } catch {}
  }

  if (existsSync(verdictPath) && force) {
    try {
      const parsed = JSON.parse(readFileSync(verdictPath, "utf8"));
      if (parsed && typeof parsed === "object" && (parsed as { head?: unknown }).head === head) {
        try {
          if (!existsSync(join(plan, "log.md"))) writeFileSync(join(plan, "log.md"), "");
          appendFileSync(join(plan, "log.md"), `- ${isoLocal()} judge-run ${repoName}: FORCE_REJUDGE no HEAD ${head}\n`);
        } catch {}
      }
    } catch {}
  }

  mkdirSync(judgeDir, { recursive: true });
  const ts = nowStamp();
  const logPath = join(judgeDir, `${repoName}-${ts}.log`);

  const prompt =
    "Você é o judge cego do PLAN em " + plan + "/PLAN.md (leia também " + plan + "/TASK-*.md). Revise SOMENTE o diff `git diff main...HEAD` deste repo.\n" +
    "Para cada AC e cada TASK, um item. Marque \"regression\": true apenas se algo que funcionava na main (teste, AC, comportamento) passa a falhar com este diff; achado novo ou melhoria é regression false.\n" +
    "Última linha da resposta, exatamente um JSON numa linha só:\n" +
    '{"verdict":"pass|fail","items":[{"ref":"AC|TASK-NN","ok":true,"regression":false,"evidence":"arquivo:linha ...","severity":"simples|grave"}],"summary":"..."}';

  const codexBin = opts.codexBin || process.env.MANDA_CODEX_BIN || "codex";
  const env = { ...(process.env as Record<string, string>), ...(opts.env ?? {}) };

  const proc = Bun.spawnSync([codexBin, "exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=high", "-s", "read-only", "-C", ".", prompt], {
    cwd: wt,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 1200000,
    env,
  });

  const stdout = proc.stdout ? proc.stdout.toString() : "";
  const stderr = proc.stderr ? proc.stderr.toString() : "";
  writeFileSync(logPath, stdout + (stderr ? (stdout.endsWith("\n") ? "" : "\n") + stderr : ""));

  // extrai o último JSON com verdict (como grep -o '{"verdict".*' | tail -1)
  let jsonStr: string | null = null;
  const start = (stdout + stderr).lastIndexOf('{"verdict"');
  const combined = stdout + stderr;
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < combined.length; i += 1) {
      const ch = combined[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          jsonStr = combined.slice(start, i + 1);
          break;
        }
      }
    }
  }

  let parsed: unknown = null;
  if (jsonStr) {
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = null;
    }
  }

  const ok =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    ((parsed as { verdict?: unknown }).verdict === "pass" || (parsed as { verdict?: unknown }).verdict === "fail") &&
    Array.isArray((parsed as { items?: unknown }).items) &&
    ((parsed as { items: unknown[] }).items as unknown[]).every(
      (it) => it && typeof it === "object" && typeof (it as { regression?: unknown }).regression === "boolean",
    );

  if (!ok) {
    const msg = `{"error":"judge sem JSON válido","log":"${logPath}"}`;
    console.log(msg);
    return { exitCode: 3, why: msg, logPath };
  }

  const judgeJson = parsed as Record<string, unknown>;
  writeFileSync(verdictPath, JSON.stringify({ head, log: logPath, judge: judgeJson }));

  console.log(JSON.stringify({ judge: verdictPath, head }));
  return { exitCode: 0, head, judgePath: verdictPath, logPath };
}

export const judgeRun = runJudge;
export const runJudgePlan = runJudge;
export const judgeRunPlan = runJudge;
export const mandaJudge = runJudge;

export async function main(argv: string[]): Promise<number> {
  // recusa LLM agent primeiro
  const check = insideLlmAgent(process.ppid);
  if (check.refused) {
    console.log(`{"error":"recusado: chamado de dentro de um agente LLM (pid ${check.pid}: ${check.label}); só o pipeline.sh pode"}`);
    return 30;
  }

  let plan: string | undefined;
  let repo: string | undefined;
  let branch: string | undefined;
  let root: string | undefined;
  let repoName: string | undefined;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root") {
      root = argv[i + 1];
      i += 1;
    } else if (arg === "--repo-name") {
      repoName = argv[i + 1];
      i += 1;
    } else if (arg === "--force-rejudge" || arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      // ignore unknown flags gracefully
    } else if (plan === undefined) {
      plan = arg;
    } else if (repo === undefined) {
      repo = arg;
    } else if (branch === undefined) {
      branch = arg;
    }
  }

  if (!plan || !repo || !branch) {
    console.error("Usage: manda judge <PLAN> <repo> <branch> [--root <dir>] [--repo-name <name>] [--force-rejudge]");
    return 2;
  }

  const res = await runJudge({ plan, repo, branch, root, repoName, forceRejudge: force, skipAgentCheck: true });
  return res.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}