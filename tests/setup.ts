import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Preload do `bun test` (bunfig.toml): remove de `process.env.PATH` os diretórios que contêm um
 * executável `ginga`, para a suíte não depender do `ginga` do host (hermetismo — T114).
 */
function hasGinga(dir: string): boolean {
  if (!dir) return false;
  try {
    const p = join(dir, "ginga");
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const raw = process.env.PATH ?? "";
const parts = raw.split(delimiter);
const kept = parts.filter((d) => !hasGinga(d));
if (kept.length !== parts.length) {
  process.env.PATH = kept.join(delimiter);
}
