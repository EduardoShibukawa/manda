---
mode: padrao
goal: "manda red <PLAN> executa a materialização RED pela CLI e valida cada arquivo de tests_frozen"
done_when: "bun test tests/red_cli.test.ts"
touch:
  - src/red.ts
  - src/cli.ts
  - tests/red_cli.test.ts
  - tasks/T159/PLAN.md
tests_frozen: [tests/red_cli.test.ts]
---

## Contexto
- A CLI deve chamar redPlan e a fila deve usar JSON.
- Cada tests_frozen ausente falha citando seu caminho.
