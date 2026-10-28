---
mode: padrao
goal: "O adapter pi do manda não tem provider/modelo padrão: sem rota explícita ele falha fechado com mensagem clara"
touch:
  - src/runtime/pi.ts
  - tests/runtime_pi_opencode.test.ts
tests_frozen: ["tests/runtime_pi_opencode.test.ts"]
done_when: "bun test tests/runtime_pi_opencode.test.ts"
---
# T9: pi.ts fail-closed (PLAN-0008 TASK-01-pi-fail-closed)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-01-pi-fail-closed.md`.
