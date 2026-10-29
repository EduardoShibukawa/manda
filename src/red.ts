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

export function redPlan(_options: RedPlanOptions): { tasks: RedTaskResult[] } {
  return { tasks: [] };
}
