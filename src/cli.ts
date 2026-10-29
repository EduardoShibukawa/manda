import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeMain } from "./routing";

import { CycleError, loadBundle, resolvePlanDir } from "./bundle";
import { findLlmAgent } from "./llm_guard";
import { runMerge } from "./merge";
import { installLink } from "./install";
import { contextMain } from "./context/port";
import { replan } from "./replan";

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

  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    console.log(
      "Usage: manda <command>\n\nCommands:\n  version [--json]        Show manda version\n  install                 Link manda into ~/.local/bin\n  run <PLAN> [--task T]   Run the tasks of a PLAN\n  context <cap> [arg] [--json]  Architectural context via provider (gira|rg|<comando>)",
    );
    return 0;
  }

  if (command === "install") {
    const result = installLink();
    console.log(JSON.stringify(result));
    if (!result.onPath) {
      console.error(`aviso: ~/.local/bin não está no PATH; adicione-o para chamar "manda" direto`);
    }
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

  if (command === "merge") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const [planArg, repoArg, branchArg] = positional;
    if (!planArg || !repoArg || !branchArg) {
      console.error("Usage: manda merge <PLAN> <repo> <branch> [--json]");
      return 2;
    }
    return runMerge({ plan: planArg, repo: repoArg, branch: branchArg }).exitCode;
  }

  if (command === "judge") {
    const valueOpts = new Set(["--root", "--base", "--head", "--models", "--repo-name"]);
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a.startsWith("--")) {
        if (a.includes("=")) continue;
        if (valueOpts.has(a)) i += 1;
        continue;
      }
      positionals.push(a);
    }
    const target = positionals.length >= 3 ? "judge_run.ts" : "judge.ts";
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, target), ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "pipeline" || command === "lane") {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "pipeline.ts"), command, ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "kill_and_retry") {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "verbs.ts"), "kill_and_retry", ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "rotate_model") {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "verbs.ts"), "rotate_model", ...rest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  }

  if (command === "replan") {
    const [planArg, taskArg] = rest.filter((arg) => !arg.startsWith("--"));
    if (!planArg || !taskArg) {
      console.error("Usage: manda replan <PLAN> <TASK>");
      return 2;
    }

    const root = process.cwd();
    const planDir = join(root, ".ginga", "plans", planArg);
    const prompt = join(root, ".ginga", "prompts", "replan.md");
    const planner = (argv: string[], cwd: string): { code: number; stdout: string } => {
      const context = argv[argv.length - 1] ?? "";
      const result = Bun.spawnSync(
        ["claude", "-p", "--model", "claude-opus-5-5", `${readFileSync(prompt, "utf8")}\n\n${context}`],
        { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };
    const lint = (argv: string[], cwd: string): { code: number; stdout: string } => {
      const result = Bun.spawnSync(["ginga", "lint", argv[1] ?? cwd, "--json"], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };

    const result = replan({ root, plan: planArg, task: taskArg, receipts: [], judge: "", diff: "", planner, lint });
    console.log(JSON.stringify(result));
    return result.result === "replanned" ? 0 : 1;
  }

  if (command === "context") {
    return contextMain(rest, process.cwd());
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

const GUARDED_COMMANDS = new Set(["merge", "judge", "pipeline", "lane"]);

/**
 * Entrada do bin/manda (T101): os verbos de processo (merge|judge|pipeline|lane)
 * recusam com exit 30 quando um ancestral é agente LLM, igual ao merge-gate.sh.
 * `run()` segue sem guarda: a suíte de testes roda in-process sob o operador.
 */
export function main(args: string[]): number {
  const command = args[0];
  if (command !== undefined && GUARDED_COMMANDS.has(command)) {
    const check = findLlmAgent(process.ppid);
    if (check.refused) {
      console.log(
        `{"error":"recusado: chamado de dentro de um agente LLM (pid ${check.pid}: ${check.label}); só o pipeline.sh pode"}`,
      );
      return 30;
    }
  }
  return run(args);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
