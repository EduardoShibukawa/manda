---
mode: padrao
goal: "manda red fica disponivel na CLI e herda o ambiente do processo para o pinga falso"
done_when: "bun test tests/red_cli.test.ts"
touch:
  - src/cli.ts
  - tests/red_cli.test.ts
  - tasks/T160/PLAN.md
tests_frozen: [tests/red_cli.test.ts]
---
