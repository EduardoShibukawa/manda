import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectConfig {
  commands: Record<string, string>;
  runtimes: Record<string, unknown>;
  context: Record<string, unknown>;
}

/** Read `.ginga/project.toml`. Missing file = empty defaults. */
export function loadProject(root: string): ProjectConfig {
  const p = join(root, ".ginga", "project.toml");
  if (!existsSync(p)) return { commands: {}, runtimes: {}, context: {} };
  const parsed = Bun.TOML.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  return {
    commands: (parsed.commands as Record<string, string>) ?? {},
    runtimes: (parsed.runtimes as Record<string, unknown>) ?? {},
    context: (parsed.context as Record<string, unknown>) ?? {},
  };
}

/**
 * Comando de `[commands]` (T903): o valor do project.toml, o padrão quando a
 * chave falta, ou `null` quando o projeto desliga a chamada com `"none"`.
 * Config ilegível vale como ausente.
 */
export function projectCommand(root: string, key: string, dflt: string): string | null {
  let value: unknown;
  try {
    value = loadProject(root).commands[key];
  } catch {
    value = undefined;
  }
  const cmd = typeof value === "string" && value.trim() ? value.trim() : dflt;
  return cmd === "none" ? null : cmd;
}

/** Aspas simples de shell: o valor chega ao comando como um argumento só. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Roda um comando de `[commands]` no shell, com `{vars}` já entre aspas.
 * env por valor: filhos Bun não vêem mutações de process.env após o boot. */
export function runProjectCommand(
  command: string,
  vars: Record<string, string>,
  cwd: string,
): { code: number | null; stdout: string; stderr: string } {
  const filled = command.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? shellQuote(vars[k]!) : m));
  const r = Bun.spawnSync(["/bin/sh", "-c", filled], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
