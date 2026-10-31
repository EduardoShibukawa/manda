import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeMain } from "./routing";

import { CycleError, loadBundle, resolvePlanDir } from "./bundle";
import { findLlmAgent } from "./llm_guard";
import { runMerge } from "./merge";
import { installLink } from "./install";
import { contextMain } from "./context/port";
import { buildReplanContext as buildReplanContextImported, replan } from "./replan";
import { redPlan } from "./red";
import { checkPaidCall, extractTotalCostUsd } from "./cost_cap";

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
    const positional = rest.filter((arg) => !arg.startsWith("--"));
    const [planArg, taskArg] = positional;
    if (!planArg || !taskArg) {
      console.error("Usage: manda replan <PLAN> <TASK>");
      return 2;
    }

    let rootArg: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === "--root") {
        rootArg = rest[i + 1];
        i += 1;
        continue;
      }
      if (a.startsWith("--root=")) {
        rootArg = a.slice("--root=".length);
        continue;
      }
    }

    const root = rootArg ? rootArg : process.cwd();
    const planDir = join(root, ".ginga", "plans", planArg);
    const promptPath = join(root, ".ginga", "prompts", "replan.md");
    const promptText = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";

    const receipts: string[] = [];
    const queueRes = Bun.spawnSync(["pinga", "queue", "--json"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (queueRes.exitCode === 0) {
      try {
        const parsed = JSON.parse(queueRes.stdout.toString());
        const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        const relevant = tasks.filter((t: any) => t && (t.plan === planArg || t.task === taskArg));
        for (const t of relevant) {
          const receipt = t?.receipt;
          if (typeof receipt === "string") receipts.push(receipt);
          else if (receipt && typeof receipt === "object") {
            const reason = (receipt as any).reason_code;
            receipts.push(typeof reason === "string" ? reason : JSON.stringify(receipt));
          }
        }
      } catch {
        // contexto degradado: sem receipts
      }
    }
    const lastReceipts = receipts.slice(-3);

    let judge = "";
    const judgeDir = join(planDir, "judge");
    if (existsSync(judgeDir)) {
      try {
        for (const file of readdirSync(judgeDir).filter((f) => f.endsWith(".json")).sort()) {
          judge += readFileSync(join(judgeDir, file), "utf8") + "\n";
        }
      } catch {
        // contexto degradado: sem judge
      }
    }

    const planNumber = planArg.match(/PLAN-(\d{4})/)?.[1] ?? planArg;
    const branch = `plan/${planNumber}`;
    const statRes = Bun.spawnSync(["git", "diff", `main...${branch}`, "--stat"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const diffRes = Bun.spawnSync(["git", "diff", `main...${branch}`], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const diff = [statRes.stdout.toString().trim(), diffRes.stdout.toString()].filter(Boolean).join("\n\n");

    let plannerCmd: string[] = ["claude", "-p", "--model", "claude-opus-5-5"];
    const fallbackCmd: string[] = ["opencode", "run", "-m", "opencode-go/deepseek-v4-pro"];
    try {
      const raw = Bun.TOML.parse(readFileSync(join(root, ".ginga", "project.toml"), "utf8")) as any;
      const roles = raw?.roles;
      if (Array.isArray(roles?.planner)) {
        plannerCmd = roles.planner.map((v: any) => String(v));
      } else if (typeof roles?.planner === "string" && roles.planner.trim()) {
        plannerCmd = roles.planner.trim().split(/\s+/);
      }
    } catch {
      // usa padrão
    }

    const context = buildReplanContextImported({ root, plan: planArg, task: taskArg, receipts: lastReceipts, judge, diff });

    const resolveBin = (name: string): string => {
      if (name.includes("/")) return name;
      const r = Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "pipe", env: process.env });
      const out = r.stdout.toString().trim();
      return out || name;
    };
    const planner = (cmd: string[]): { code: number; stdout: string } => {
      const bin = resolveBin(cmd[0]!);
      const result = Bun.spawnSync([bin, ...cmd.slice(1), `${promptText}\n\n${context}`], {
        cwd: planDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };

    const lint = (argv: string[], cwd: string): { code: number; stdout: string } => {
      const result = Bun.spawnSync(["ginga", "lint", argv[1] ?? cwd, "--json"], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };

    const extractModel = (cmd: string[]): string | undefined => {
      const idx = cmd.findIndex(c => c === "--model" || c === "-m");
      if (idx !== -1 && idx + 1 < cmd.length) return cmd[idx + 1];
      return undefined;
    };
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let claudeCosts: number[] = [];
    const primaryModel = extractModel(plannerCmd);
    const costCheckPrimary = checkPaidCall({
      root,
      since: since24,
      next_estimate_usd: 0.15,
      model: primaryModel,
      claudeCosts,
    });
    if (!costCheckPrimary.allow) {
      console.log(JSON.stringify({ result: "blocked", reason: costCheckPrimary.reason || "budget" }));
      return 1;
    }

    let plannerRes = planner(plannerCmd);
    const costPrimary = extractTotalCostUsd(plannerRes.stdout);
    if (costPrimary !== undefined) claudeCosts.push(costPrimary);

    if (plannerRes.code !== 0) {
      const fallbackModel = extractModel(fallbackCmd);
      const costCheckFallback = checkPaidCall({
        root,
        since: since24,
        next_estimate_usd: 0.15,
        model: fallbackModel,
        claudeCosts,
      });
      if (!costCheckFallback.allow) {
        console.log(JSON.stringify({ result: "blocked", reason: costCheckFallback.reason || "budget" }));
        return 1;
      }
      plannerRes = planner(fallbackCmd);
      const costFallback = extractTotalCostUsd(plannerRes.stdout);
      if (costFallback !== undefined) claudeCosts.push(costFallback);
    }

    const result = replan({
      root,
      plan: planArg,
      task: taskArg,
      receipts: lastReceipts,
      judge,
      diff,
      model: primaryModel ?? extractModel(fallbackCmd),
      since: since24,
      claudeCosts,
      planner: () => plannerRes,
      lint,
    });
    console.log(JSON.stringify(result));
    return result.result === "replanned" ? 0 : 1;
  }

  if (command === "red") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const planArg = positional[0];
    if (!planArg) {
      console.error("Usage: manda red <PLAN> --repo <repo> [--root <dir>]");
      return 2;
    }
    let repoArg: string | undefined;
    let rootArg: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === "--repo") {
        repoArg = rest[i + 1];
        i += 1;
        continue;
      }
      if (a.startsWith("--repo=")) {
        repoArg = a.slice("--repo=".length);
        continue;
      }
      if (a === "--root") {
        rootArg = rest[i + 1];
        i += 1;
        continue;
      }
      if (a.startsWith("--root=")) {
        rootArg = a.slice("--root=".length);
        continue;
      }
    }
    if (!repoArg) {
      console.error("Usage: manda red <PLAN> --repo <repo> [--root <dir>]");
      return 2;
    }
    const root = rootArg ? rootArg : process.cwd();
    const pinga = (argv: string[], cwd: string): { code: number; stdout: string } => {
      const result = Bun.spawnSync(["pinga", ...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };
    const git = (argv: string[], cwd: string): { code: number; stdout: string } => {
      const result = Bun.spawnSync(["git", ...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
    };
    try {
      const res = redPlan({ root, plan: planArg, repo: repoArg, pinga, git });
      console.log(JSON.stringify(res));
      return 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      return 1;
    }
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
