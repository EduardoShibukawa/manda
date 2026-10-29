---
mode: padrao
goal: "manda judge <PLAN> <repo> <branch>: port de .ginga/bin/judge-run.sh (veredito JSON com head e regression por item, um veredito por HEAD, recusa em agente LLM)"
touch:
  - src/judge_run.ts
  - src/judge.ts
  - src/cli.ts
  - src/judge-run.ts
  - tasks/T19/PLAN.md
tests_frozen: []
done_when: "bun test tests/judge_blind.test.ts"
---
# T19: manda judge (port judge-run.sh) — PLAN-0022 TASK-02
Materializada de PLAN-0022 TASK-02.