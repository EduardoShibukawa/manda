---
mode: padrao
goal: "redPlan cria a worktree do plano antes de montar `taken`, varrendo tasks/T*/ da main na primeira execução (achado do judge em TASK-02 e TASK-16)"
done_when: "bun test tests/red_taken.test.ts"
touch:
  - src/red.ts
  - tests/red_taken.test.ts
  - tasks/T167/PLAN.md
tests_frozen: [tests/red_taken.test.ts]
---
