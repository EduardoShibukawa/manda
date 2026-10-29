---
mode: padrao
goal: "manda red <PLAN> copia os testes_frozen, prova o RED e comita uma TASK por vez"
done_when: "bun test tests/red.test.ts"
touch:
  - src/red.ts
  - src/cli.ts
  - tests/red.test.ts
  - tests/fixtures/red/TASK-01-a.md
  - tests/fixtures/red/TASK-02-b.md
  - tests/fixtures/red/frozen.test.ts
  - tests/fixtures/red/case.txt
  - tasks/T156/PLAN.md
tests_frozen: [tests/red.test.ts, tests/fixtures/red/TASK-01-a.md, tests/fixtures/red/TASK-02-b.md, tests/fixtures/red/frozen.test.ts, tests/fixtures/red/case.txt]
---

## Contexto
- `redPlan` recebe runners injetáveis para pinga e git.
- A worktree vem da main; cada TASK recebe id, plano e commit próprios.
