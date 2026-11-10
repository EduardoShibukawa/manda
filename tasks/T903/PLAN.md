---
mode: padrao
goal: "lint, lessons e cost saem de [commands] do project.toml; ginga vira só o valor padrão e \"none\" desliga a chamada"
touch:
  - src/project.ts
  - src/plan.ts
  - src/cli.ts
  - src/plan_lessons.ts
  - src/cost_cap.ts
  - tests/commands_config.test.ts
  - tasks/T903/PLAN.md
tests_frozen: ["tests/commands_config.test.ts"]
done_when: "bun test tests/commands_config.test.ts tests/plan_lessons.test.ts tests/cost_cap_wiring.test.ts tests/cost_cap.test.ts tests/plan_cmd.test.ts tests/plan_lint_real.test.ts tests/bundle.test.ts"
---
# T903: fim das chamadas fixas ao ginga (fase 1)

- `projectCommand(root, key, padrão)` em `src/project.ts`: valor do toml, padrão, ou null com "none".
- `runProjectCommand` roda no shell com `{vars}` entre aspas simples.
- Padrões: `ginga lint {dir} --json`, `ginga lessons find --touch {touch} --json`, `ginga cost --json`.
- Os fallbacks de hoje ficam: lint ausente passa, lessons varre os arquivos, cost soma local.
