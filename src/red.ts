import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allocTaskIds } from "./alloc";
import { loadBundle } from "./bundle";

export type Runner = (argv: string[], cwd: string) => { code: number; stdout: string };

export interface RedPlanOptions {
  root: string;
  plan: string;
  repo: string;
  pinga: Runner;
  git: Runner;
}

export interface RedTaskResult {
  task: string;
  pinga_task: string;
  red: boolean;
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function copyRecursive(src: string, dest: string) {
  if (!existsSync(src)) return;
  const s = statSync(src);
  if (s.isDirectory()) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
  } else {
    ensureDir(dirname(dest));
    writeFileSync(dest, readFileSync(src));
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = text.slice(3, end).trim();
  if (!yaml) return {};
  try {
    const parsed = Bun.YAML.parse(yaml);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function dumpFrontmatter(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else if (typeof v === "string") {
      // try to match style - if it looks like simple token, maybe unquote
      if (/^[A-Za-z0-9][A-Za-z0-9_\-\/\.]*$/.test(v) && !v.includes(":") && !v.includes("#")) {
        lines.push(`${k}: ${v}`);
      } else {
        lines.push(`${k}: ${JSON.stringify(v)}`);
      }
    } else if (typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function replaceFrontmatter(text: string, fm: Record<string, unknown>): string {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const rest = text.slice(end + 4); // skip \n---
      // rest may start with \n
      return dumpFrontmatter(fm) + (rest.startsWith("\n") ? rest : "\n" + rest);
    }
  }
  return dumpFrontmatter(fm) + text;
}

export function redPlan(options: RedPlanOptions): { tasks: RedTaskResult[] } {
  const { root, plan, repo, pinga, git } = options;

  const planDir = join(root, ".ginga", "plans", plan);
  if (!existsSync(planDir)) {
    throw new Error(`plan not found: ${planDir}`);
  }

  // load bundle of tasks
  const bundle = loadBundle(planDir);
  const tasks = bundle.tasks;

  // get taken pinga_task ids from queue if possible
  const taken: string[] = [];
  try {
    const q = pinga(["queue", "--json"], root);
    if (q.code === 0 && q.stdout) {
      try {
        const parsed = JSON.parse(q.stdout);
        if (parsed && Array.isArray(parsed.tasks)) {
          for (const t of parsed.tasks) {
            if (t && typeof t.task === "string") taken.push(t.task);
          }
        }
      } catch {}
    }
  } catch {}
  // also include already allocated pinga_task from the plan tasks
  for (const t of tasks) {
    const pt = (t as any).pinga_task;
    if (typeof pt === "string") taken.push(pt);
  }

  // allocate ids for tasks without pinga_task
  const toAllocate = tasks.filter((t) => {
    const fm = t as Record<string, unknown>;
    return !fm.pinga_task;
  });
  const ids = allocTaskIds(taken, toAllocate.length);
  const idMap = new Map<string, string>();
  for (let i = 0; i < toAllocate.length; i++) {
    idMap.set((toAllocate[i] as any).task, ids[i]);
  }

  // determine worktree
  const planSuffix = plan.match(/PLAN-(\d{4})/)?.[1] || plan;
  const worktree = join(root, `${repo}-plan-${planSuffix}`);
  const branch = `plan/${planSuffix}`;

  // create worktree from main if missing
  if (!existsSync(worktree)) {
    // ensure repo exists as git repo? test sets up repo under root/manda and also creates worktree under root/manda-plan-0042
    // try to create worktree from root's main or from repo's main
    const res = git(["worktree", "add", "-b", branch, worktree, "main"], root);
    if (res.code !== 0) {
      // try in repo dir
      const repoPath = join(root, repo);
      if (existsSync(repoPath)) {
        const res2 = git(["-C", repoPath, "worktree", "add", "-b", branch, worktree, "main"], repoPath);
        if (res2.code !== 0) {
          throw new Error(res2.stdout || String(res2.code));
        }
      } else {
        throw new Error(res.stdout || String(res.code));
      }
    }
  }

  // copy frozen files from planDir/frozen/<repo> to worktree
  const frozenSrc = join(planDir, "frozen", repo);
  if (!existsSync(frozenSrc)) {
    // look for specific test file mentioned in tasks
    // try to find any tests_frozen
    throw new Error(join("tests", "frozen.test.ts"));
  }

  // validate individually each tests_frozen before materializing
  for (const task of tasks) {
    const fmTask = task as Record<string, unknown>;
    const testsFrozen = (fmTask.tests_frozen as string[]) || [];
    for (const tf of testsFrozen) {
      const srcPath = join(frozenSrc, tf);
      if (!existsSync(srcPath)) {
        throw new Error(tf);
      }
    }
  }

  copyRecursive(frozenSrc, worktree);

  const results: RedTaskResult[] = [];

  for (const task of tasks) {
    const taskId = (task as any).task as string;
    const fmTask = task as Record<string, unknown>;
    if (fmTask.pinga_task) {
      // already has pinga_task, skip?
      results.push({ task: taskId, pinga_task: String(fmTask.pinga_task), red: false });
      continue;
    }
    const pingaTask = idMap.get(taskId)!;
    const taskFileInPlan = join(planDir, `${taskId}.md`);
    const taskText = existsSync(taskFileInPlan) ? readFileSync(taskFileInPlan, "utf8") : "";
    const fm = parseFrontmatter(taskText);
    Object.assign(fm, fmTask);

    // ensure required fields from task
    const testsFrozen = (fm.tests_frozen as string[]) || (fmTask.tests_frozen as string[]) || [];
    // find first test file in frozen to check? or just use done_when
    const doneWhen = (fm.done_when as string) || (fmTask.done_when as string) || "";

    // create tasks/T<N>/PLAN.md in worktree
    const taskPlanDir = join(worktree, "tasks", pingaTask);
    ensureDir(taskPlanDir);
    const taskPlanContent = `---\nmode: ${fm.mode || fmTask.mode}\ngoal: ${JSON.stringify(fm.goal || fmTask.goal)}\ndone_when: ${JSON.stringify(doneWhen)}\ntouch: ${JSON.stringify(fm.touch || fmTask.touch || [])}\ntests_frozen: ${JSON.stringify(testsFrozen)}\n---\n`;
    writeFileSync(join(taskPlanDir, "PLAN.md"), taskPlanContent);

    // run pinga prove-red
    const proveRes = pinga(["prove-red", join("tasks", pingaTask, "PLAN.md")], worktree);
    if (proveRes.stdout && proveRes.stdout.includes("test_passed_on_base")) {
      // mark as blocked
      const updatedFm = { ...fm, pinga_task: pingaTask, blocked: true, reason: "test_passed_on_base" };
      // write back to plan task file
      writeFileSync(taskFileInPlan, replaceFrontmatter(taskText || dumpFrontmatter(updatedFm), updatedFm));
      results.push({ task: taskId, pinga_task: pingaTask, red: false });
      continue;
    }
    if (proveRes.code !== 0) {
      throw new Error(`pinga prove-red failed for ${pingaTask}: ${proveRes.stdout}`);
    }

    // red is true - commit
    // stage all changes in worktree
    git(["add", "."], worktree);
    git(["commit", "-m", `test(${pingaTask}): RED`], worktree);

    // update plan task file with pinga_task
    const updatedFm2 = { ...fm, pinga_task: pingaTask };
    writeFileSync(taskFileInPlan, replaceFrontmatter(taskText || dumpFrontmatter(updatedFm2), updatedFm2));

    results.push({ task: taskId, pinga_task: pingaTask, red: true });
  }

  return { tasks: results };
}
