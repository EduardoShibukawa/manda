import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Runner = (argv: string[], cwd: string) => { code: number; stdout: string };

export interface ReplanContextOptions {
  root: string;
  plan: string;
  task: string;
  receipts: unknown[];
  judge?: string;
  diff: string;
}

export interface ReplanOptions extends ReplanContextOptions {
  planner: Runner;
  lint: Runner;
}

export interface ReplanResult {
  result: "replanned" | "blocked";
  reason: string;
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function buildReplanContext(options: ReplanContextOptions): string {
  const planDir = join(options.root, ".ginga", "plans", options.plan);
  const task = readIfPresent(join(planDir, `${options.task}.md`));
  const learnings = readIfPresent(join(planDir, "LEARNINGS.md"));
  const receipts = options.receipts.slice(-3).map((receipt) => {
    if (typeof receipt === "string") return receipt;
    if (receipt && typeof receipt === "object") {
      const value = (receipt as { reason_code?: unknown }).reason_code;
      if (typeof value === "string") return value;
    }
    return JSON.stringify(receipt);
  });
  const diff = options.diff.slice(0, 20_000);

  return [
    "# TASK",
    task.trimEnd(),
    "# RECEIPTS",
    receipts.join("\n"),
    "# JUDGE",
    options.judge ?? "",
    "# DIFF",
    diff,
    "# LEARNINGS",
    learnings.trimEnd(),
  ].join("\n\n");
}

export function replan(options: ReplanOptions): ReplanResult {
  const planDir = join(options.root, ".ginga", "plans", options.plan);
  const context = buildReplanContext(options);
  const prompt = join(options.root, ".ginga", "prompts", "replan.md");
  const planner = options.planner(["--file", prompt, "--task", options.task, context], planDir);

  if (planner.code !== 0) {
    return {
      result: "blocked",
      reason: planner.stdout.trim() || `planner saiu ${planner.code}`,
    };
  }

  const lint = options.lint(["lint", planDir], planDir);
  if (lint.code !== 0) {
    return {
      result: "blocked",
      reason: lint.stdout.trim() || `lint saiu ${lint.code}`,
    };
  }

  return { result: "replanned", reason: "lint ok" };
}
