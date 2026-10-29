---
mode: mvp
goal: "Antes de cada chamada paga de qualquer papel, o manda soma o gasto real do opencode.db e do claude -p e nega a chamada que passaria do teto"
done_when: "bun test tests/cost_cap.test.ts"
touch:
  - src/cost_cap.ts
  - tests/cost_cap.test.ts
  - tests/fixtures/opencode-cost.sql
  - tasks/T155/PLAN.md
tests_frozen: [tests/cost_cap.test.ts, tests/fixtures/opencode-cost.sql]
---

## Contexto
- `spentUsd` soma `session_v2.cost` desde `since`, em SQLite somente leitura, e soma os custos do Claude.
- `capCheck` nega quando `spent_usd + next_estimate_usd > cap_usd`; no limite, permite.
- A fixture tem sessões de US$ 0,10, US$ 0,25 e US$ 0,00.
