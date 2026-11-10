import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "./project";
import { git } from "./worktree";

export interface GateInput {
  /** Identificador da TASK (ex.: PLAN-0001/TASK-01). */
  task: string;
  /** Identificador do PLAN (ex.: PLAN-0001). */
  plan: string;
  /** Raiz do repositório (trunk). */
  repo: string;
  /** Diretório da worktree onde o comando roda. */
  worktree: string;
  /** Contrato da TASK, usado quando não há `[commands].verify`. */
  doneWhen: string;
  /** Branch de referência para o diff de `tests_frozen`. */
  base?: string;
  /** Testes congelados que o executor não pode tocar. */
  testsFrozen?: string[];
  /** Id pelo qual o gate conhece a TASK (placeholder `{gate_id}`, T905). */
  gateId?: string;
  /** Raiz do workspace (bundle): segunda fonte de `[commands].verify` (T908). */
  root?: string;
  /** Comando de verificação explícito; vence a config do projeto. */
  verify?: string;
}

export type GateReason = "verify_failed" | "tests_frozen_changed";

export interface GateResult {
  passed: boolean;
  command: string;
  exitCode: number;
  reason?: GateReason;
  restored?: string[];
  stdout?: string;
  stderr?: string;
}

/** Exit espelhado do guard `tests_frozen_changed` do verificador. */
const TESTS_FROZEN_CHANGED_EXIT = 5;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function statusPaths(worktree: string): string[] {
  // -uall: sem ele, pastas inteiras não rastreadas colapsam em `dir/` e escapam
  // do match exato contra `tests_frozen`.
  const out = git(["-C", worktree, "status", "--porcelain", "-uall"], worktree).stdout;
  const paths: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    if (!raw) continue;
    const target = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
    paths.push(normalize(target.replace(/^"(.*)"$/, "$1")));
  }
  return paths;
}

function committedPaths(worktree: string, base: string): string[] {
  const diff = git(["-C", worktree, "diff", "--name-only", `${base}...HEAD`], worktree);
  const out =
    diff.code === 0
      ? diff.stdout
      : git(["-C", worktree, "diff", "--name-only", base, "HEAD"], worktree).stdout;
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(normalize);
}

/** Caminhos que a worktree mudou em relação à base, comitados ou não. */
export function changedPaths(worktree: string, base = "main"): string[] {
  return [...new Set([...committedPaths(worktree, base), ...statusPaths(worktree)])].sort();
}

/** Restaura o arquivo congelado a partir da base, no index e no working tree. */
function restoreFromBase(worktree: string, base: string, path: string): boolean {
  return git(["-C", worktree, "checkout", base, "--", path], worktree).code === 0;
}

/**
 * Sem versão na base para restaurar, "restaurar" é remover o arquivo:
 * `git rm --cached -f` + apagar do disco. Pode falhar sem quebrar o gate.
 */
function removeFromWorktree(worktree: string, path: string): void {
  git(["-C", worktree, "rm", "--cached", "-f", "--", path], worktree);
  try {
    rmSync(join(worktree, path), { force: true });
  } catch {
    // devolvemos o caminho na lista mesmo assim
  }
}

function applyPlaceholders(command: string, input: GateInput): string {
  return command
    .replaceAll("{task}", input.task)
    .replaceAll("{plan}", input.plan)
    .replaceAll("{repo}", input.repo)
    .replaceAll("{worktree}", input.worktree)
    .replaceAll("{gate_id}", input.gateId ?? "");
}

/** `[commands].verify` da config do projeto, lido do trunk. A worktree é
 * mutável pelo executor e não pode definir o próprio gate. */
function configuredVerify(repo: string, root?: string): string | undefined {
  // trunk do repo primeiro; depois a raiz do workspace, onde o bundle e o
  // project.toml costumam morar (T908). A worktree nunca define o próprio gate.
  for (const dir of root && root !== repo ? [repo, root] : [repo]) {
    try {
      const verify = loadProject(dir).commands.verify;
      if (typeof verify === "string" && verify.trim()) return verify;
    } catch {
      // config ilegível não derruba o gate: segue para a próxima / done_when
    }
  }
  return undefined;
}

/**
 * Proteção de `tests_frozen` ANTES do gate: se a worktree tocou um teste
 * congelado, restaura da base e falha com `tests_frozen_changed` sem executar
 * o comando de verificação.
 */
export function protectTestsFrozen(input: GateInput): string[] {
  const frozen = (input.testsFrozen ?? []).map(normalize);
  if (frozen.length === 0) return [];

  const base = input.base ?? "main";
  const touched = changedPaths(input.worktree, base).filter((p) => frozen.includes(p));
  if (touched.length === 0) return [];

  // Todo toque é violação, com ou sem restauração possível. Sem versão na
  // base, a "restauração" é remover o arquivo; a lista sai de todo jeito.
  const handled: string[] = [];
  for (const path of touched) {
    if (!restoreFromBase(input.worktree, base, path)) removeFromWorktree(input.worktree, path);
    handled.push(path);
  }
  return handled;
}

/** Roda o gate de uma TASK na worktree. */
export async function runGate(input: GateInput): Promise<GateResult> {
  const restored = protectTestsFrozen(input);
  if (restored.length > 0) {
    return {
      passed: false,
      command: "",
      exitCode: TESTS_FROZEN_CHANGED_EXIT,
      reason: "tests_frozen_changed",
      restored,
    };
  }

  const raw = input.verify ?? configuredVerify(input.repo, input.root) ?? input.doneWhen;
  const command = applyPlaceholders(raw, input);

  const r = Bun.spawnSync(["bash", "-lc", command], {
    cwd: input.worktree,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = r.exitCode ?? 1;

  return {
    passed: exitCode === 0,
    command,
    exitCode,
    ...(exitCode === 0 ? {} : { reason: "verify_failed" as const }),
    restored: [],
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}
