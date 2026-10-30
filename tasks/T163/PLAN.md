---
mode: padrao
goal: "Guarda do planner no `manda replan` da CLI mede o gasto real (since=24h, claudeCosts com total_cost_usd do planner) e bloqueia antes de cada chamada paga do planner (primária e fallback), repassando model/since/claudeCosts para a guarda interna de replan()"
done_when: "bun test tests/replan_cli_cost.test.ts tests/replan_cli.test.ts tests/cost_cap_wiring.test.ts tests/replan.test.ts"
touch:
  - src/cli.ts
  - src/cost_cap.ts
  - src/replan.ts
  - tests/replan_cli_cost.test.ts
  - tasks/T163/PLAN.md
tests_frozen: [tests/replan_cli_cost.test.ts]
---

## Contexto
- Achado grave do judge (2026-10-30, refs AC e TASK-12): em src/cli.ts a guarda do planner usava since=agora e claudeCosts:[], o planner rodava antes da guarda de replan.ts, o fallback não re-checava e claudeCosts nunca recebia total_cost_usd.
- RED em tests/replan_cli_cost.test.ts: gasto de 24h no opencode.db bloqueia sem chamar o claude; total_cost_usd 0.90 do planner bloqueia o fallback sem chamar o opencode; extractTotalCostUsd via import dinâmico.
- Fix: since = agora−24h; claudeCosts acumulando extractTotalCostUsd de cada chamada; checkPaidCall antes da primária e antes do fallback; replan() recebe model/since/claudeCosts.
- Não editar tests/cost_cap_wiring.test.ts, tests/cost_cap.test.ts, tests/replan_cli.test.ts nem fixtures; não mudar capCheck/spentUsd/checkPaidCall; sem TOTAL_CAP de ambiente; sem rede.
