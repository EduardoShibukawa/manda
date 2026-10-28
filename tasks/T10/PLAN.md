---
mode: padrao
goal: "manda route <TASK> --json resolve runtime/provider/modelo pela precedência project.toml > ROUTING > padrão"
touch:
  - src/routing.ts
  - src/family.ts
  - src/cli.ts
  - tests/routing.test.ts
  - tests/fixtures/models/
tests_frozen: ["tests/routing.test.ts", "tests/fixtures/models/primary/ROUTING.md", "tests/fixtures/models/alt/ROUTING.md", "tests/fixtures/models/home/ROUTING.md"]
done_when: "bun test tests/routing.test.ts"
---
# T10: manda route com precedência (PLAN-0008 TASK-03-routing-manda)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-03-routing-manda.md`.
