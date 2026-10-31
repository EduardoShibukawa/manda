---
mode: mvp
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: free
goal: "classifyBlocked mapeia o texto de BLOCKED/falha de gate para uma classe e uma ação, por regras de dados testadas com fixtures"
done_when: "bun test tests/blocked.test.ts"
tests_frozen: [tests/blocked.test.ts, tests/fixtures/blocked/scope_drift.txt, tests/fixtures/blocked/id_collision.txt, tests/fixtures/blocked/quota.txt, tests/fixtures/blocked/gate_false_positive.txt, tests/fixtures/blocked/contract_conflict.txt, tests/fixtures/blocked/missing_dep.txt, tests/fixtures/blocked/env_dependency.txt, tests/fixtures/blocked/other.txt]
touch: [src/blocked.ts, src/failure_rules.json, tests/blocked.test.ts, tests/fixtures/blocked/, tasks/T171/PLAN.md]
pinga_task: T171
---
## Context
PLAN-0029 TASK-07. `failure_rules.json` lista `{class, action, pattern}` em ordem; `classifyBlocked` devolve a primeira que casa. 8 fixtures cobrem todas as classes.
