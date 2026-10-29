import { chmodSync, lstatSync, readlinkSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface InstallResult {
  link: string;
  target: string;
  created: boolean;
  onPath: boolean;
}

/**
 * Cria o symlink `<home>/.local/bin/manda` apontando para o `bin/manda.ts` do
 * pacote (T111). Idempotente: link já correto é mantido; link ou arquivo
 * errado é substituído. Retorna o estado sem imprimir nada.
 */
export function installLink(home = process.env.HOME ?? homedir()): InstallResult {
  const target = join(import.meta.dir, "..", "bin", "manda.ts");
  chmodSync(target, 0o755);

  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "manda");

  let existing: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const raw = readlinkSync(link);
      existing = isAbsolute(raw) ? raw : resolve(binDir, raw);
    }
  } catch {
    existing = null; // link ausente
  }

  let created = false;
  if (existing !== target) {
    rmSync(link, { force: true }); // substitui link errado ou arquivo comum
    symlinkSync(target, link);
    created = true;
  }

  const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
  return { link, target, created, onPath };
}
