import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

/**
 * `manda merge <PLAN> <repo> <branch>`: reproduz o gate determinístico de
 * `.ginga/bin/merge-gate.sh` (sem LLM). Um único JSON de 1 linha na saída e
 * o código de saída do gate:
 *
 *   0  mergeado (com MERGE_GATE=1 e log no PLAN do dir)
 *   2  branch sem worktree | main não está na main | mudanças não commitadas
 *   10 sem veredito (judge/<repo>.json) ou veredito de outro HEAD
 *   11 item do judge com regression=true
 *   12 TASK do diff main...HEAD sem receipt done no `pinga queue`
 *   13 falha de teste nova na branch que a main não tem
 *   14 main ganhou falha depois do merge -> `git revert -m 1` automático
 *   15 merge feito, mas `pinga ledger verify` falhou (merge fica)
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

  // --- 12: TASKs do diff main...HEAD com receipt done no pinga
  const wanted = new Set(
    [...gitOut(["diff", "--name-only", "main...HEAD"], wt).matchAll(/tasks\/(T\d+)\//g)].map((m) => m[1]!),
  );
  if (wanted.size > 0) {
    // env explícito: filhos Bun não vêem mutações de process.env feitas após
    // o boot (PATH do stub de teste), então o ambiente é passado por valor.
    const q = Bun.spawnSync(["pinga", "queue", "--json", "--root", wt], { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    let queueTasks: unknown[] = [];
    try {
      const j: unknown = JSON.parse(q.stdout.toString());
      if (j && typeof j === "object" && Array.isArray((j as { tasks?: unknown }).tasks)) {
        queueTasks = (j as { tasks: unknown[] }).tasks;
      }
    } catch {}
    // Uma TASK do diff que não apareça na fila do pinga (ou não esteja
    // `done`) conta como pendente: ausência na fila == pendente (exit 12).
    const stateByTask = new Map<string, unknown>();
    for (const t of queueTasks) {
      const e = t as { task?: unknown; state?: unknown };
      if (typeof e.task === "string") stateByTask.set(e.task, e.state);
    }
    const pending = [...wanted].filter((task) => stateByTask.get(task) !== "done");
    if (pending.length > 0) return finish(12, `sem receipt done: ${pending.join(" ")}`);
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

  // --- 15: ledger tem que continuar íntegro com o merge já feito
  if (Bun.spawnSync(["pinga", "ledger", "verify"], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env } }).exitCode !== 0) {
    return finish(15, "merge feito, mas pinga ledger verify falhou");
  }

  return finish(0, `mergeado ${gitOut(["rev-parse", "--short", "HEAD"])}`, true);
}
