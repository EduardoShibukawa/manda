---
mode: padrao
goal: "redPlan monta `taken` varrendo tasks/T*/ do worktree e incluindo pinga_task de TODAS as TASKs do bundle"
done_when: "bun test tests/red_taken.test.ts"
touch:
  - src/red.ts
  - tests/red_taken.test.ts
  - tasks/T166/PLAN.md
tests_frozen: [tests/red_taken.test.ts]
---
