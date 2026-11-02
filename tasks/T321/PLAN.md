---
mode: padrao
repo: manda
plan: PLAN-0034-pi-liga-guarda-de-escopo
tier: medium
goal: "o runtime pi do manda passa -e para a extensão e as variáveis de escopo derivadas do frontmatter da TASK, só quando a TASK declara touch"
done_when: "bun test tests/runtime_pi_scope.test.ts tests/runtime_pi_opencode.test.ts tests/runtime_pi_text.test.ts"
tests_frozen: [tests/runtime_pi_scope.test.ts]
touch: [src/runtime/pi.ts, tests/runtime_pi_scope.test.ts]
pinga_task: T321
---
## Contexto
- PLAN-0034 TASK-01. A guarda existe (PLAN-0032: src/runtime/pi_scope_guard.ts lê MANDA_SCOPE_TOUCH/FROZEN/ROOT do env); falta ligar no `pi -p`.
- Contrato do teste congelado: o escopo da TASK chega no env do request (`MANDA_TASK_TOUCH`/`MANDA_TASK_FROZEN`, listas JSON derivadas do frontmatter pelo chamador, como GINGA_GUARD_LANE); com touch declarado, argv ganha `-e <abs>/src/runtime/pi_scope_guard.ts` (coexiste com o `-e` do guard, PLAN-0033) e o env do spawn ganha MANDA_SCOPE_TOUCH/FROZEN (JSON) e MANDA_SCOPE_ROOT=req.worktree; sem touch → não liga; `[routing] scope_guard = false` em `<G>/.ginga/project.toml` (G do env) desliga, padrão true.
- Não alterar port.ts nem run.ts: o escopo entra pelo env do request.
