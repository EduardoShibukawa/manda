---
type: task
mode: padrao
goal: "manda route <TASK> --json resolve runtime/provider/modelo pela precedência project.toml > ROUTING > padrão"
plan: PLAN-0008
depends_on: []
tier: medium
touch:
    - src/routing.ts
    - src/family.ts
    - src/cli.ts
    - tests/routing.test.ts
    - tests/fixtures/models/
done_when: "bun test tests/routing.test.ts"
tests_frozen: ["tests/routing.test.ts", "tests/fixtures/models/primary/ROUTING.md", "tests/fixtures/models/alt/ROUTING.md", "tests/fixtures/models/home/ROUTING.md"]
---
