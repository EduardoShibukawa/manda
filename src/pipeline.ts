import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { runJudge } from "./judge_run";
import { runMerge } from "./merge";
import { emitEvent } from "./events";

export interface PipelineOptions {
  /** Repositório trunk (manda/p-inga/...). */
  repo: string;
  /** Número máximo de rodadas. */
  rounds?: number;
  /** Raiz do workspace (onde ficam .ginga/plans). Default: cwd. */
  root?: string;
  /** Prompt a ser passado ao operador (opencode). Opcional. */
  prompt?: string;
  /** Pula a execução do operador (modo determinístico). */
  skipOperator?: boolean;
}

export interface PipelineResult {
  exitCode: number;
  rounds: number;
  summary: string;
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
  // .ginga/plans/<PLAN>/ready/<repo>.json -> .ginga/plans/<PLAN>
  return join(readyFile, "..", "..");
}

function backlogCount(root: string, repoName: string): number {
  const bl = join(root, ".ginga", "prompts", `backlog-${repoName}.md`);
  if (!existsSync(bl)) return 0;
  const text = readFileSync(bl, "utf8");
  return (text.match(/^- \[ \]/gm) || []).length;
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

  let executed = 0;
  let summary = "";
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

    const main0 = git(["rev-parse", "main"], repo);

    // Operador (opcional): só roda se houver prompt e opencode disponível.
    if (opts.prompt && !opts.skipOperator && !process.env.MANDA_PIPELINE_SKIP_OPERATOR) {
      const oc = Bun.spawnSync(["which", "opencode"], { stdout: "pipe", stderr: "pipe" });
      if (oc.exitCode === 0) {
        const op = Bun.spawnSync(
          ["opencode", "run", "--standalone", "--auto", "-m", "opencode-go/beam-free", opts.prompt],
          { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 7200000 },
        );
        if (op.exitCode !== 0 && op.exitCode !== null) {
          // segue; abort só se main andou
        }
      }
    }

    if (git(["rev-parse", "main"], repo) !== main0) {
      const msg = "CRÍTICO: a main mudou durante o operador (fora do gate). Lane parada.";
      console.error(msg);
      emitEvent("lane.round", { round: i, status: "main_moved" }, scope);
      return { exitCode: 20, rounds: executed, summary: msg };
    }

    let roundSummary = "";
    for (const rf of rlist) {
      const planDir = planDirOf(rf);
      const branch = branchOf(rf);
      if (!branch) continue;
      const j = await runJudge({ plan: planDir, repo, branch, skipAgentCheck: true });
      if (j.exitCode !== 0) {
        roundSummary += `${basename(planDir)}: judge falhou; `;
        continue;
      }
      const g = runMerge({ plan: planDir, repo, branch });
      roundSummary += `${basename(planDir)}: gate ${g.exitCode}; `;
      if (g.exitCode === 0) {
        try {
          mkdirSync(join(planDir, "ready", "done"), { recursive: true });
          renameSync(rf, join(planDir, "ready", "done", `${repoName}-${Date.now()}.json`));
        } catch {}
      }
    }
    summary = roundSummary || "nenhum ready";
    emitEvent("heartbeat", { entity: `lane:${repoName}`, pid: process.pid, progress: executed, summary }, scope);
    emitEvent("lane.round", { round: i, status: "end", summary }, scope);
    console.log(`rodada ${i}: ${summary}`);

    // progresso: se nada mudou, para
    // (simplificado: continua até rounds)
  }

  return { exitCode: 0, rounds: executed, summary };
}

export async function main(argv: string[]): Promise<number> {
  // Detecta modo lane quando chamado como `manda lane`
  let isLane = argv[0] === "lane";
  let rest = argv;
  if (rest[0] === "pipeline" || rest[0] === "lane") {
    if (rest[0] === "lane") isLane = true;
    rest = rest.slice(1);
  }

  // Usage
  if (rest.length === 0) {
    if (isLane) {
      console.error("Usage: manda lane <repo> [rounds] [--root <dir>]");
    } else {
      console.error("Usage: manda pipeline <prompt> [--repo <repo>] [--rounds N] [--root <dir>] [--skip-operator]");
    }
    return 2;
  }

  // Parse
  let prompt: string | undefined;
  let repo = "manda";
  let rounds = 6;
  let root = process.cwd();
  let skipOperator = false;

  const args = [...rest];
  // Se o primeiro arg não for flag, é o prompt (ou repo no modo lane)
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
