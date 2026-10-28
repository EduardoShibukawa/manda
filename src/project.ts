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
