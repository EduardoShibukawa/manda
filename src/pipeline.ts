import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { runJudge } from "./judge_run";
import { runMerge } from "./merge";
import { emitEvent } from "./events";

export interface PipelineOptions {
  repo: string;
  rounds?: number;
  root?: string;
  prompt?: string;
  skipOperator?: boolean;
  models?: string[];
  idleThresholdMs?: number;
  pollMs?: number;
}

export interface PipelineResult {
  exitCode: number;
  rounds: number;
  summary: string;
  progress: number;
}

function repoPath(repo: string, root: string): string {
  return isAbsolute(repo) ? repo : join(root, repo);
}

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}

function readys(root: string, repoName: string): string[] {
  const out: string[] = [];
  const plansDir = join(root, ".ginga", "plans");
  if (!existsSync(plansDir)) return out;
  for (const p of readdirSync(plansDir)) {
    const readyDir = join(plansDir, p, "ready");
    const f = join(readyDir, `${repoName}.json`);
    if (existsSync(f)) out.push(f);
  }
  return out;
}

function branchOf(readyFile: string): string {
  try {
    return JSON.parse(readFileSync(readyFile, "utf8")).branch;
  } catch {
    return "";
  }
}

function planDirOf(readyFile: string): string {
  return join(readyFile, "..", "..");
}

function backlogCount(root: string, repoName: string): number {
  const bl = join(root, ".ginga", "prompts", `backlog-${repoName}.md`);
  if (!existsSync(bl)) return 0;
  const text = readFileSync(bl, "utf8");
  return (text.match(/^- \[ \]/gm) || []).length;
}

export const DEFAULT_MODELS = ["opencode/glm-5.3-flash-free", "opencode-go/beam-free"];

/** Lê `[supervisor] models` (array de strings) de `<root>/.ginga/project.toml`; ausente/inválido → DEFAULT_MODELS. */
export function loadSupervisorModels(root: string): string[] {
  try {
    const toml = Bun.TOML.parse(readFileSync(join(root, ".ginga", "project.toml"), "utf8")) as {
      supervisor?: { models?: unknown };
    };
    const models = toml?.supervisor?.models;
    if (Array.isArray(models) && models.length > 0 && models.every((m) => typeof m === "string")) {
      return models as string[];
    }
  } catch {}
  return DEFAULT_MODELS;
}

export function killByPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

export function findFresh(repoPaths: string[], sinceMs?: number): boolean {
  const since = sinceMs ? new Date(sinceMs).toISOString() : "60 seconds ago";
  for (const rp of repoPaths) {
    try {
      const r = Bun.spawnSync(
        ["find", rp, "-type", "f", "-newermt", since, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (r.stdout.toString().trim()) return true;
    } catch {}
  }
  return false;
}

export function hasRealProgress(logPath: string, repoPaths: string[], lastBytes: number, sinceMs?: number): { changed: boolean; bytes: number } {
  let nonBuildBytes = 0;
  try {
    const text = readFileSync(logPath, "utf8");
    const nonBuild = text
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("> build"))
      .join("\n");
    nonBuildBytes = nonBuild.length;
  } catch {}
  const fresh = findFresh(repoPaths, sinceMs);
  const changed = fresh || nonBuildBytes > lastBytes;
  return { changed, bytes: nonBuildBytes };
}

export function buildRoundPrompt(root: string, repoName: string, round: number, name?: string): { path: string; content: string } {
  const opBasePath = join(root, ".ginga", "prompts", "op-base.md");
  const opBase = existsSync(opBasePath) ? readFileSync(opBasePath, "utf8") : "";
  const rlist = readys(root, repoName);
  let content = opBase + "\n";
  content += "\n## Lane " + repoName + ", rodada " + round + ": só o repo `" + repoName + "`. Achados do judge primeiro (o gate barrou), depois o backlog.\n";
  for (const rf of rlist) {
    const planDir = planDirOf(rf);
    const planName = basename(planDir);
    const branch = branchOf(rf);
    content += "\n### " + planName + " (branch " + branch + ")\n";
    const logPath = join(planDir, "log.md");
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const last = lines[lines.length - 1] || "";
      content += "- gate: " + last + "\n";
    }
    const judgePath = join(planDir, "judge", repoName + ".json");
    if (existsSync(judgePath)) {
      try {
        const j = JSON.parse(readFileSync(judgePath, "utf8"));
        for (const item of j?.judge?.items || []) {
          if (!item.ok) {
            content += "- [" + item.ref + "]" + (item.regression ? " REGRESSÃO" : "") + " " + item.evidence + "\n";
          }
        }
      } catch {}
    }
  }
  const blPath = join(root, ".ginga", "prompts", "backlog-" + repoName + ".md");
  content += "\n## Backlog\n";
  if (existsSync(blPath)) content += readFileSync(blPath, "utf8") + "\n";
  const promptName = name || "lane-" + repoName + "-" + Date.now() + "-r" + round;
  const promptPath = join(root, ".ginga", "prompts", promptName + ".md");
  try {
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, content);
  } catch {}
  return { path: promptPath, content };
}

export const runPipeline = runLane;
export function runLane(opts: PipelineOptions): Promise<PipelineResult> {
  return runPipelineImpl(opts);
}

async function runPipelineImpl(opts: PipelineOptions): Promise<PipelineResult> {
  const root = opts.root || process.cwd();
  const repo = repoPath(opts.repo, root);
  const repoName = basename(repo);
  const rounds = opts.rounds ?? 6;
  const scope = { repo: repoName };
  const models = opts.models ?? loadSupervisorModels(root);
  let modelIndex = 0;
  const idleThresholdMs = opts.idleThresholdMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 60000;

  let executed = 0;
  let summary = "";
  let effects = 0;

  const repoPaths = [repo];
  try {
    for (const e of readdirSync(root)) {
      if (e.startsWith(repoName + "-") || e.startsWith(repoName + "_")) {
        repoPaths.push(join(root, e));
      }
    }
  } catch {}

  for (let i = 1; i <= rounds; i += 1) {
    const rlist = readys(root, repoName);
    const bl = backlogCount(root, repoName);
    if (rlist.length === 0 && bl === 0) {
      emitEvent("lane.round", { round: i, status: "nothing_pending" }, scope);
      summary = "nada pendente; encerrada";
      break;
    }
    emitEvent("lane.round", { round: i, status: "start", readys: rlist.length, backlog: bl }, scope);
    executed = i;

    const name = "lane-" + repoName + "-" + Date.now() + "-r" + i;
    const { path: promptPath, content } = opts.prompt
      ? { path: join(root, ".ginga", "prompts", name + ".md"), content: opts.prompt }
      : buildRoundPrompt(root, repoName, i, name);
    try {
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, content);
    } catch {}

    const main0 = git(["rev-parse", "main"], repo);
    const roundStartMs = Date.now();

    if (!opts.skipOperator && !process.env.MANDA_PIPELINE_SKIP_OPERATOR) {
      const model = models[modelIndex];
      const opCmd = ["opencode", "run", "--standalone", "--auto", "-m", model, "--title", name, content];
      const logPath = join(root, ".ginga", "handoffs", name + ".log");
      try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}
      writeFileSync(logPath, "");

      let proc: any = null;
      try {
        proc = Bun.spawn(opCmd, { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
      } catch {
        proc = null;
      }

      if (proc) {
        const pump = async (stream: any) => {
          if (!stream) return;
          const reader = stream.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try { appendFileSync(logPath, dec.decode(value)); } catch {}
          }
        };
        pump(proc.stdout);
        pump(proc.stderr);

        let lastProgressBytes = 0;
        let idle = 0;
        let prevTickMs = roundStartMs;
        while (proc.exitCode === null) {
          await Bun.sleep(pollMs);
          const tickMs = Date.now();
          const hp = hasRealProgress(logPath, repoPaths, lastProgressBytes, prevTickMs);
          prevTickMs = tickMs;
          if (hp.changed) {
            idle = 0;
            lastProgressBytes = hp.bytes;
          } else {
            idle += pollMs;
          }
          if (idle >= idleThresholdMs) {
            killByPid(proc.pid);
            modelIndex = (modelIndex + 1) % models.length;
            emitEvent("lane.round", { round: i, status: "infra_stuck", killedPid: proc.pid }, scope);
            break;
          }
        }
        try { await proc.exited; } catch {}
      }
    }

    if (git(["rev-parse", "main"], repo) !== main0) {
      const msg = "CRÍTICO: a main mudou durante o operador (fora do gate). Lane parada.";
      console.error(msg);
      emitEvent("lane.round", { round: i, status: "main_moved" }, scope);
      return { exitCode: 20, rounds: executed, summary: msg, progress: effects };
    }

    let roundSummary = "";
    const beforeEffects = effects;
    for (const rf of rlist) {
      const planDir = planDirOf(rf);
      const branch = branchOf(rf);
      if (!branch) continue;
      const j = await runJudge({ plan: planDir, repo, branch, skipAgentCheck: true });
      if (j.exitCode !== 0) {
        roundSummary += basename(planDir) + ": judge falhou; ";
        continue;
      }
      const g = runMerge({ plan: planDir, repo, branch });
      roundSummary += basename(planDir) + ": gate " + g.exitCode + "; ";
      if (g.exitCode === 0) {
        try {
          mkdirSync(join(planDir, "ready", "done"), { recursive: true });
          const { renameSync } = await import("node:fs");
          renameSync(rf, join(planDir, "ready", "done", repoName + "-" + Date.now() + ".json"));
        } catch {}
        effects += 1;
      }
    }
    summary = roundSummary || "nenhum ready";
    const progress = effects;
    emitEvent("heartbeat", { entity: "lane:" + repoName, pid: process.pid, progress, summary }, scope);
    emitEvent("lane.round", { round: i, status: "end", summary }, scope);
    console.log("rodada " + i + ": " + summary);

    if (effects === beforeEffects && rlist.length > 0 && !process.env.MANDA_FORCE_CONTINUE) {
      break;
    }
  }

  return { exitCode: 0, rounds: executed, summary, progress: effects };
}

export async function main(argv: string[]): Promise<number> {
  let isLane = argv[0] === "lane";
  let rest = argv;
  if (rest[0] === "pipeline" || rest[0] === "lane") {
    if (rest[0] === "lane") isLane = true;
    rest = rest.slice(1);
  }

  if (rest.length === 0) {
    if (isLane) {
      console.error("Usage: manda lane <repo> [rounds] [--root <dir>]");
    } else {
      console.error("Usage: manda pipeline <prompt> [--repo <repo>] [--rounds N] [--root <dir>] [--skip-operator]");
    }
    return 2;
  }

  let prompt: string | undefined;
  let repo = "manda";
  let rounds = 6;
  let root = process.cwd();
  let skipOperator = false;

  const args = [...rest];
  if (args[0] && !args[0]!.startsWith("--")) {
    if (isLane) {
      repo = args.shift()!;
    } else {
      prompt = args.shift()!;
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--repo") {
      repo = args[i + 1]!;
      i += 1;
    } else if (a === "--rounds") {
      rounds = Number(args[i + 1]);
      i += 1;
    } else if (a === "--root") {
      root = args[i + 1]!;
      i += 1;
    } else if (a === "--skip-operator") {
      skipOperator = true;
    } else if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
    } else if (a.startsWith("--rounds=")) {
      rounds = Number(a.slice("--rounds=".length));
    } else if (a.startsWith("--root=")) {
      root = a.slice("--root=".length);
    }
  }

  if (isLane && !repo) {
    console.error("Usage: manda lane <repo> [rounds] [--root <dir>]");
    return 2;
  }

  const res = await runPipeline({ repo, rounds, root, prompt, skipOperator });
  return res.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
