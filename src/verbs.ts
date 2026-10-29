import { emitEvent } from "./events";

export interface KillAndRetryOptions {
  pid: number;
  reason?: string;
  entity?: string;
}

export function killAndRetry(opts: KillAndRetryOptions): number {
  const pid = opts.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    // ignora: processo pode já ter morrido
  }
  emitEvent("kill_and_retry", { pid, reason: opts.reason ?? "", entity: opts.entity ?? "" }, {});
  return 0;
}

export interface RotateModelOptions {
  entity: string;
  model: string;
  reason?: string;
}

export function rotateModel(opts: RotateModelOptions): number {
  emitEvent("rotate_model", { entity: opts.entity, model: opts.model, reason: opts.reason ?? "" }, {});
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "kill_and_retry") {
    const rest = argv.slice(1);
    if (rest.length === 0) {
      console.error("Usage: manda kill_and_retry <pid> [--reason <text>] [--entity <name>]");
      return 2;
    }
    const pid = Number(rest[0]);
    if (!Number.isFinite(pid)) {
      console.error("Usage: manda kill_and_retry <pid> [--reason <text>] [--entity <name>]");
      return 2;
    }
    let reason: string | undefined;
    let entity: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i] === "--reason") { reason = rest[i + 1]; i += 1; }
      else if (rest[i] === "--entity") { entity = rest[i + 1]; i += 1; }
    }
    return killAndRetry({ pid, reason, entity });
  }
  if (cmd === "rotate_model") {
    const rest = argv.slice(1);
    // rotate_model <entity> <model> [--reason <text>]
    if (rest.length < 2) {
      console.error("Usage: manda rotate_model <entity> <model> [--reason <text>]");
      return 2;
    }
    const entity = rest[0]!;
    const model = rest[1]!;
    let reason: string | undefined;
    for (let i = 2; i < rest.length; i += 1) {
      if (rest[i] === "--reason") { reason = rest[i + 1]; i += 1; }
    }
    return rotateModel({ entity, model, reason });
  }
  // Permite chamada direta sem o subcomando
  console.error("Usage: manda kill_and_retry <pid> | manda rotate_model <entity> <model>");
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
