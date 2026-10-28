import { join } from "node:path";
import { routeMain } from "./routing";

import { CycleError, loadBundle, resolvePlanDir } from "./bundle";

export interface VersionJson {
  schema_version: number;
  name: string;
  version: string;
}

export const VERSION = "0.1.0";

export function run(args: string[]): number {
  const [command, ...rest] = args;

  if (command === "version") {
    const version: VersionJson = {
      schema_version: 1,
      name: "manda",
      version: VERSION,
    };
    if (rest.includes("--json")) {
      console.log(JSON.stringify(version));
    } else {
      console.log(`manda ${version.version}`);
    }
    return 0;
  }

  if (command === "help" || command === undefined) {
    console.log(
      "Usage: manda <command>\n\nCommands:\n  version [--json]        Show manda version\n  run <PLAN> [--task T]   Run the tasks of a PLAN",
    );
    return 0;
  }

  if (command === "run") {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "run.ts"), ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "judge") {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "judge.ts"), ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "route") {
    return routeMain(rest);
  }

  if (command === "plan") {
    if (rest.length === 0) {
      console.error("Usage: manda plan <INTENT|SPEC> [--root <dir>]\n       manda plan show <PLAN> [--json] [--root <dir>]");
      return 2;
    }
    if (rest[0] === "show") {
      if (rest.length < 2 || rest[1] === undefined) {
        console.error("Usage: manda plan show <PLAN> [--json] [--root <dir>]");
        return 2;
      }
      const json = rest.includes("--json");
      const rootIdx = rest.indexOf("--root");
      const root = rootIdx !== -1 ? rest[rootIdx + 1] : undefined;
      const dir = resolvePlanDir(rest[1], { root });
      if (!dir) {
        console.error(`plan not found: ${rest[1]}`);
        return 2;
      }
      try {
        const bundle = loadBundle(dir);
        if (json) console.log(JSON.stringify(bundle));
        else console.log(bundle.tasks.map((t) => t.task).join("\n"));
        return 0;
      } catch (e) {
        if (e instanceof CycleError) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
    }
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "plan.ts"), ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  console.error(`Unknown command: ${command}`);
  return 2;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
