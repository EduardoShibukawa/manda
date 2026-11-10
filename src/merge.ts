import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { loadProject } from "./project";

/**
 * `manda merge <PLAN> <repo> <branch>`: reproduz o gate determinístico de
 * `.ginga/bin/merge-gate.sh` (sem LLM). Um único JSON de 1 linha na saída e
 * o código de saída do gate:
 *
 *   0  mergeado (com MERGE_GATE=1 e log no PLAN do dir) + limpeza da
 *      worktree e da branch (WIP sem commit vai antes para `<plan>/wip/*.patch`)
 *   2  branch sem worktree | main não está na main | mudanças não commitadas
 *   10 sem veredito (judge/<repo>.json) ou veredito de outro HEAD
 *   11 item do judge com regression=true
 *   12 `[commands].gate` recusou as TASKs do diff main...HEAD (padrão: `pinga gate`)
 *   13 falha de teste nova na branch que a main não tem
 *   14 main ganhou falha depois do merge -> `git revert -m 1` automático
 *   15 merge feito, mas `[commands].post_merge` falhou (padrão: `pinga ledger verify`; merge fica)
 *   16 o revert falhou (CRÍTICO)
 *   17 passe vazio: veredito sem nenhum item para o repo (judge.items ausente ou [])
 */

export interface MergeOptions {
  /** Dir do PLAN (onde ficam judge/, queue.json, log.md). */
  plan: string;
  /** Dir (ou nome) do repositório git trunk. */
  repo: string;
  /** Branch a ser mergeada (normalmente de uma worktree do repo). */
  branch: string;
  /** Nome lógico do repo (chave de judge/<nome>.json). Inferido quando omitido. */
  repoName?: string;
}

export interface MergeResult {
  exitCode: number;
  why: string;
  /** true quando o merge commit ficou na main (gate 0). */
  merged?: boolean;
}

/** `date -Iseconds`: 2026-10-28T16:00:00-03:00 */
function isoLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/**
 * Veredito do judge do repositório (`judge/<nome>.json`, cabeçalho `head` +
 * `judge.items`). Com `repoName` a busca é direta; sem ele, o nome é inferido:
 * 1º `<basename(repo)>.json`, senão o único .json no dir, senão o cujo `head`
 * bate com o HEAD da worktree da branch.
 */
interface Verdict {
  name: string;
  path: string;
}

function resolveVerdict(plan: string, repo: string, repoName: string | undefined, head: string): Verdict | null {
  const dir = join(plan, "judge");
  if (repoName) {
    const p = join(dir, `${repoName}.json`);
    return existsSync(p) ? { name: repoName, path: p } : null;
  }
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {}
  const direct = `${basename(repo)}.json`;
  if (files.includes(direct)) return { name: basename(repo), path: join(dir, direct) };
  if (files.length === 1) return { name: files[0]!.slice(0, -5), path: join(dir, files[0]!) };
  for (const f of files) {
    try {
      if (JSON.parse(readFileSync(join(dir, f), "utf8"))?.head === head) {
        return { name: f.slice(0, -5), path: join(dir, f) };
      }
    } catch {}
  }
  return null;
}

/** `(fail)` de `bun test` num diretório, sem o sufixo de duração; sort -u. */
function testFails(dir: string): string[] {
  const r = Bun.spawnSync(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString() + r.stderr.toString();
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("(fail)"))
    .map((l) => l.replace(/ \[[0-9.]+m?s\]$/, "").trimEnd())
    .filter((l) => l.length > 0);
  return [...new Set(lines)].sort();
}

/**
 * Limpeza pós-merge (só no caminho do exit 0): arquiva WIP sem commit da
 * worktree como patch no PLAN, remove a worktree e apaga a branch (`-d`,
 * nunca `-D`). Qualquer falha é só aviso em stderr: exit 0 e merged=true
 * permanecem.
 */
function cleanupAfterMerge(repo: string, wt: string, branch: string, plan: string): void {
  const warn = (msg: string) => console.warn(`AVISO: limpeza pos-merge ${msg}`);
  const git = (args: string[], cwd = repo) =>
    Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  // pular se o processo está dentro da própria worktree (remover o chão)
  const rel = relative(wt, process.cwd());
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    warn(`pulada: o cwd atual esta dentro da worktree ${wt}`);
    return;
  }

  // 1: WIP (mudança/untracked) vira patch binário no PLAN antes de remover
  const status = git(["status", "--porcelain"], wt);
  if (status.exitCode !== 0) {
    warn(`git status em ${wt} falhou: ${status.stderr.toString().trim()}`);
    return;
  }
  if (status.stdout.toString().trim()) {
    if (git(["add", "-A"], wt).exitCode !== 0) {
      warn("git add -A da worktree falhou, WIP nao sera removido");
      return;
    }
    const patch = join(
      plan,
      "wip",
      `${branch.replace(/\//g, "-")}-${new Date().toISOString().replace(/[:.]/g, "-")}.patch`,
    );
    mkdirSync(join(plan, "wip"), { recursive: true });
    const diff = git(["diff", "--cached", "--binary", "HEAD", `--output=${patch}`], wt);
    if (diff.exitCode !== 0) {
      warn(`git diff do WIP falhou, worktree nao sera removida: ${diff.stderr.toString().trim()}`);
      return;
    }
  }

  // 2: worktree fora; 3: branch apagada (-d: só se estiver mergeada)
  const remove = git(["worktree", "remove", "--force", wt]);
  if (remove.exitCode !== 0) {
    warn(`git worktree remove falhou: ${remove.stderr.toString().trim()}`);
    return;
  }
  const del = git(["branch", "-d", branch]);
  if (del.exitCode !== 0) {
    warn(`git branch -d ${branch} falhou: ${del.stderr.toString().trim()}`);
  }
}

/** Padrões de `[commands]` do merge (T902): o manda não conhece o pinga, só
 * carrega estes valores quando o projeto não configura os seus. */
export const DEFAULT_GATE = "pinga gate --root {worktree} {tasks}";
export const DEFAULT_POST_MERGE = "pinga ledger verify";

/** `[commands]` do trunk e, se o trunk não tem project.toml, do bundle do PLAN
 * (`<root>/.ginga/plans/<PLAN>`). A worktree nunca define o próprio gate. */
function mergeCommands(repo: string, plan: string): { gate: string; postMerge: string } {
  let commands: Record<string, string> = {};
  for (const root of [repo, join(plan, "..", "..", "..")]) {
    try {
      if (!existsSync(join(root, ".ginga", "project.toml"))) continue;
      commands = loadProject(root).commands;
      break;
    } catch {
      // config ilegível: segue para a próxima raiz / padrões
    }
  }
  const pick = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim() : dflt);
  return { gate: pick(commands.gate, DEFAULT_GATE), postMerge: pick(commands.post_merge, DEFAULT_POST_MERGE) };
}

/** Roda um comando de `[commands]` no shell. env por valor: filhos Bun não
 * vêem mutações de process.env feitas após o boot (PATH do stub de teste). */
function runCommand(command: string, vars: Record<string, string>, cwd: string): { code: number; stdout: string } {
  const filled = command.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const r = Bun.spawnSync(["/bin/sh", "-c", filled], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
}

export function runMerge(opts: MergeOptions): MergeResult {
  const plan = isAbsolute(opts.plan) ? opts.plan : join(process.cwd(), opts.plan);
  const repo = isAbsolute(opts.repo) ? opts.repo : join(process.cwd(), opts.repo);
  const branch = opts.branch;
  const planName = basename(plan);

  const git = (args: string[], cwd = repo) =>
    Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const gitOut = (args: string[], cwd = repo) => git(args, cwd).stdout.toString().trim();

  let repoName = opts.repoName ?? basename(repo);
  let exit: MergeResult;

  /** 1 linha de JSON + log no PLAN do dir, como o `out()` do merge-gate.sh. */
  const finish = (gate: number, why: string, merged?: boolean): MergeResult => {
    console.log(JSON.stringify({ plan: planName, repo: repoName, branch, gate, why }));
    try {
      appendFileSync(join(plan, "log.md"), `- ${isoLocal()} merge-gate ${repoName} ${branch}: exit ${gate} (${why})\n`);
    } catch {}
    exit = { exitCode: gate, why, ...(merged ? { merged: true } : {}) };
    if (gate === 0) {
      try {
        cleanupAfterMerge(repo, wt, branch, plan);
      } catch (e) {
        console.warn(`AVISO: limpeza pos-merge falhou: ${String(e)}`);
      }
    }
    return exit;
  };

  // --- 2: a branch precisa de worktree e a main de trunk limpo
  let wt = "";
  let lastWorktree = "";
  for (const line of gitOut(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) lastWorktree = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) wt = lastWorktree;
  }
  if (!wt) return finish(2, `sem worktree para ${branch}`);

  if (gitOut(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
    return finish(2, `${repoName} nao esta na main`);
  }
  if (git(["status", "--porcelain", "--untracked-files=no"]).stdout.toString().trim()) {
    return finish(2, "main com mudancas nao commitadas");
  }

  const head = gitOut(["rev-parse", "HEAD"], wt);

  // --- 10: veredito do judge para este HEAD
  const verdict = resolveVerdict(plan, repo, opts.repoName, head);
  if (!verdict) return finish(10, `sem veredito em ${join(plan, "judge", `${opts.repoName ?? basename(repo)}.json`)}`);
  repoName = verdict.name;

  let verdictJson: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(verdict.path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) verdictJson = parsed;
  } catch {}
  if (!verdictJson) return finish(10, "veredito de outro HEAD; rode judge-run.sh");
  if (verdictJson.head !== head) return finish(10, "veredito de outro HEAD; rode judge-run.sh");

  // --- 11: item(ns) com regression=true
  const judge = verdictJson.judge as Record<string, unknown> | undefined;
  const items = Array.isArray(judge?.items) ? (judge!.items as unknown[]) : [];
  // --- 17: passe vazio (logo depois do 10, antes do 11), como o merge-gate.sh
  if (items.length === 0) {
    return finish(17, `veredito sem nenhum item para ${repoName} (passe vazio): falta TASK com repo: ${repoName} no PLAN`);
  }
  const regressions = items.filter((i) => !!(i as { regression?: unknown })?.regression).length;
  if (regressions > 0) return finish(11, `${regressions} item(ns) com regression=true`);

  // --- 12: gate de receipts das TASKs do diff main...HEAD ([commands].gate)
  const cmds = mergeCommands(repo, plan);
  const vars = { worktree: wt, repo, plan };
  const wanted = [
    ...new Set([...gitOut(["diff", "--name-only", "main...HEAD"], wt).matchAll(/tasks\/(T\d+)\//g)].map((m) => m[1]!)),
  ].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
  if (wanted.length > 0 && cmds.gate !== "none") {
    const g = runCommand(cmds.gate, { ...vars, tasks: wanted.join(" ") }, wt);
    if (g.code !== 0) {
      // gate que fala JSON ({pending:[...]}, como o `pinga gate`) nomeia as pendentes
      let pending: string[] = [];
      try {
        const j: unknown = JSON.parse(g.stdout.trim().split("\n").pop() ?? "");
        const p = (j as { pending?: unknown } | null)?.pending;
        if (Array.isArray(p)) pending = p.filter((x): x is string => typeof x === "string");
      } catch {}
      return finish(12, pending.length > 0 ? `sem receipt done: ${pending.join(" ")}` : `gate recusou ${wanted.join(" ")} (exit ${g.code})`);
    }
  }

  // --- 13: falha de teste que a main não tem
  const baseFails = testFails(repo);
  const branchFails = testFails(wt);
  const slug = (lines: string[]) => lines.filter((f) => !baseFails.includes(f)).slice(0, 3).join(" ").replace(/"/g, "_");
  const extraBranch = slug(branchFails);
  if (extraBranch) return finish(13, `falha nova na branch: ${extraBranch}`);

  // --- merge: MERGE_GATE=1 para hooks de merge saberem a origem
  const ident = (key: string) => git(["config", "--get", key]).stdout.toString().trim();
  const identity = ident("user.email") && ident("user.name") ? [] : ["-c", "user.email=manda@gate.local", "-c", "user.name=manda"];
  const mergeMsg = `Merge ${planName} (${branch}): merge-gate (judge sem regressao, receipts done, suite sem falha nova)`;
  const merge = Bun.spawnSync(["git", ...identity, "merge", "--no-ff", "-q", "-m", mergeMsg, branch], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MERGE_GATE: "1" },
  });
  if (merge.exitCode !== 0) {
    git(["merge", "--abort"]);
    return finish(2, "conflito no merge");
  }

  // --- 14: main piorou depois do merge -> revert automático
  const extraMain = slug(testFails(repo));
  if (extraMain) {
    // MERGE_GATE=1 para o hook reference-transaction do ginga não bloquear o revert
    // (sem -q: git revert (≥2.50) não aceita quiet (uso 129)).
    const revert = Bun.spawnSync(["git", "revert", "-m", "1", "--no-edit", "HEAD"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MERGE_GATE: "1" },
    });
    if (revert.exitCode !== 0) {
      const warn = `AVISO: git revert falhou (exit ${revert.exitCode}): ${revert.stderr.toString().trim()}`;
      console.warn(warn);
      return finish(16, `main ganhou falha apos merge e o REVERT FALHOU (CRÍTICO): ${extraMain}; ${warn}`);
    }
    return finish(14, `main ganhou falha apos merge, revertido: ${extraMain}`);
  }

  // --- 15: pós-merge ([commands].post_merge): o ledger tem que continuar íntegro
  if (cmds.postMerge !== "none" && runCommand(cmds.postMerge, vars, repo).code !== 0) {
    return finish(15, `merge feito, mas o pos-merge falhou (${cmds.postMerge})`);
  }

  return finish(0, `mergeado ${gitOut(["rev-parse", "--short", "HEAD"])}`, true);
}
