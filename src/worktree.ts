import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`, capturing output instead of inheriting it. */
export function git(args: string[], cwd: string): GitResult {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode ?? 1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

export function worktreePath(root: string, taskId: string): string {
  return join(root, ".worktrees", `wt-${taskId}`);
}

export function worktreeBranch(taskId: string): string {
  return `wt/${taskId}`;
}

/**
 * Cria `.worktrees/wt-<id>` na branch `wt/<id>` a partir de `baseBranch`.
 * Um diretório já existente é erro: worktree é efêmera, nunca reaproveitada.
 */
export async function createWorktree(
  root: string,
  taskId: string,
  baseBranch = "main",
): Promise<WorktreeInfo> {
  const wtDir = join(root, ".worktrees");
  if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });

  const path = worktreePath(root, taskId);
  const branch = worktreeBranch(taskId);

  if (existsSync(path)) {
    throw new Error(`Worktree já existe em ${path}`);
  }

  const { code, stdout, stderr } = git(
    ["-C", root, "worktree", "add", "-b", branch, path, baseBranch],
    root,
  );
  if (code !== 0) {
    throw new Error(`Falha ao criar worktree: ${stderr.trim() || stdout.trim()}`);
  }

  return { path, branch };
}

/**
 * Comita o que estiver pendente na branch da worktree, garante a trunk
 * corrente e faz `merge --no-ff`, devolvendo o sha do HEAD resultante.
 */
export async function mergeWorktreeToTrunk(
  root: string,
  taskId: string,
  targetBranch = "main",
): Promise<{ commitSha: string }> {
  const path = worktreePath(root, taskId);
  const branch = worktreeBranch(taskId);

  if (!existsSync(path)) {
    throw new Error(`Worktree não encontrada em ${path}`);
  }

  const status = git(["-C", path, "status", "--porcelain"], root).stdout;
  if (status.trim()) {
    git(["-C", path, "add", "."], root);
    const commit = git(
      ["-C", path, "commit", "-m", `feat(${taskId}): implement atomic task code`],
      root,
    );
    if (commit.code !== 0) {
      throw new Error(`Falha ao comitar a worktree: ${commit.stderr.trim()}`);
    }
  }

  const current = git(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root).stdout.trim();
  if (current !== targetBranch) {
    const checkout = git(["-C", root, "checkout", targetBranch], root);
    if (checkout.code !== 0) {
      throw new Error(`Falha ao trocar para ${targetBranch}: ${checkout.stderr.trim()}`);
    }
  }

  const merge = git(
    ["-C", root, "merge", "--no-ff", branch, "-m", `feat(${taskId}): merge atomic task`],
    root,
  );
  if (merge.code !== 0) {
    throw new Error(
      `Falha no merge de ${branch} em ${targetBranch}: ${merge.stderr.trim() || merge.stdout.trim()}`,
    );
  }

  const commitSha = git(["-C", root, "rev-parse", "HEAD"], root).stdout.trim();
  return { commitSha };
}

/** Remove a pasta da worktree e a branch `wt/<id>` (idempotente). */
export async function removeWorktree(root: string, taskId: string): Promise<void> {
  const path = worktreePath(root, taskId);
  const branch = worktreeBranch(taskId);

  if (existsSync(path)) {
    git(["-C", root, "worktree", "remove", "--force", path], root);
  }

  git(["-C", root, "branch", "-D", branch], root);
  git(["-C", root, "worktree", "prune"], root);

  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Worktree onde `branch` está em checkout neste repo, ou null (T905). É como
 * o `manda run` acha a branch do PLAN criada pelo `manda red`.
 */
export function worktreeOfBranch(root: string, branch: string): string | null {
  let last = "";
  for (const line of git(["-C", root, "worktree", "list", "--porcelain"], root).stdout.split("\n")) {
    if (line.startsWith("worktree ")) last = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return last;
  }
  return null;
}

/**
 * Como `mergeWorktreeToTrunk`, mas o destino é outra worktree (a da branch do
 * PLAN): comita o pendente da TASK e faz `merge --no-ff` lá. A main não anda.
 */
export async function mergeWorktreeInto(
  root: string,
  taskId: string,
  targetWorktree: string,
): Promise<{ commitSha: string }> {
  const path = worktreePath(root, taskId);
  const branch = worktreeBranch(taskId);
  if (!existsSync(path)) throw new Error(`Worktree não encontrada em ${path}`);

  if (git(["-C", path, "status", "--porcelain"], root).stdout.trim()) {
    git(["-C", path, "add", "."], root);
    const commit = git(["-C", path, "commit", "-m", `feat(${taskId}): implement atomic task code`], root);
    if (commit.code !== 0) throw new Error(`Falha ao comitar a worktree: ${commit.stderr.trim()}`);
  }

  const merge = git(
    ["-C", targetWorktree, "merge", "--no-ff", branch, "-m", `feat(${taskId}): merge atomic task`],
    targetWorktree,
  );
  if (merge.code !== 0) {
    git(["-C", targetWorktree, "merge", "--abort"], targetWorktree);
    throw new Error(`Falha no merge de ${branch} em ${targetWorktree}: ${merge.stderr.trim() || merge.stdout.trim()}`);
  }
  return { commitSha: git(["-C", targetWorktree, "rev-parse", "HEAD"], targetWorktree).stdout.trim() };
}
