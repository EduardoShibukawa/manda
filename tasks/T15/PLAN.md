---
mode: padrao
goal: "Fazer tests/e2e/two_runtimes.test.ts passar de novo em plan/0008 sem alterar o teste congelado, corrigindo run.ts (e routing.ts quando aplicável)"
touch:
  - src/run.ts
  - src/routing.ts
  - tasks/T15/PLAN.md
tests_frozen: ["tests/e2e/two_runtimes.test.ts"]
done_when: "bun test tests/e2e/two_runtimes.test.ts"
---
# T15: correção do e2e two_runtimes (PLAN-0008)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-09-e2e-correcao.md`.
