---
mode: padrao
goal: "Antes de cada chamada paga dos papéis LLM (executor em run.ts, judge em judge.ts, planner em replan.ts), o manda lê o teto em [budget] round_usd do .ginga/project.toml, mede o gasto por ginga cost --json (fallback opencode.db + claude) e bloqueia a chamada acima do teto"
done_when: "bun test tests/cost_cap_wiring.test.ts tests/cost_cap.test.ts tests/run.test.ts tests/judge_module.test.ts tests/replan.test.ts"
touch:
  - src/cost_cap.ts
  - src/run.ts
  - src/judge.ts
  - src/replan.ts
  - tests/cost_cap_wiring.test.ts
  - tasks/T168/PLAN.md
tests_frozen: [tests/cost_cap_wiring.test.ts]
---

## Contexto
- Achado grave do judge (2026-10-30) na TASK-06: `capCheck`/`spentUsd` sem chamador; `[budget] round_usd` não lido; `ginga cost --json` não usado.
- Adicionar em `src/cost_cap.ts` (sem mudar `capCheck`/`spentUsd`): `loadRoundCapUsd(root)` (TOML `[budget] round_usd`, sem → Infinity, sem fallback para TOTAL_CAP), `isPaidModel(model)` (free = prefixo `pi:` ou `/[-:]free$/i`), e `checkPaidCall({root, since, next_estimate_usd, model?, opencodeDb?, claudeCosts?, costCmd?})` — free passa; senão cap de `round_usd`, gasto via `costCmd` (padrão `["ginga","cost","--json"]`) com fallback `spentUsd`, e `capCheck`.
- Ligar antes de `adapter.run` em `run.ts` (executor) e `judge.ts` (judge), e antes do `planner(...)` em `replan.ts`; injetável via options (`costCmd`, `nextEstimateUsd` padrão 0.15). Bloqueio = sem chamar o LLM, outcome/result bloqueado.
- RED em `tests/cost_cap_wiring.test.ts` com imports dinâmicos (falha por asserção no base) + integração `runPlan` com stub: `round_usd = 1.00`, gasto 0.90 + estimativa 0.30 → adapter não chamado; gasto 0.10 → chamado.
- Não editar `tests/cost_cap.test.ts` nem a fixture; não ler `paid-spend.tsv`; sem `TOTAL_CAP` de ambiente; sem rede.
