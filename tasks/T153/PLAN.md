---
mode: mvp
goal: "Num repo git novo sem gira no PATH, INTENT vira PLAN e TASK, roda no Pi e passa no pinga verify, sem ginga"
done_when: "bun test tests/e2e/no_gira.test.ts"
touch:
  - tests/e2e/no_gira.test.ts
  - tests/e2e/stubs/pi
  - tasks/T153/PLAN.md
tests_frozen: [tests/e2e/no_gira.test.ts, tests/e2e/stubs/pi]
---

## Contexto
- Depende da T152 (pi `resultText` = texto do assistente): sem ela `manda plan` não lê a resposta do Planner.
- Repo tmp com INTENT, `provider = "rg"` e `[commands].verify` chamando o `pinga verify` real com `--ledger` temporário;
  PATH só com stub `pi`, `pinga`, bun e /usr/bin:/bin (sem gira, sem ginga). Os testes e o stub já existem.
