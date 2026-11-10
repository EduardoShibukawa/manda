---
mode: padrao
goal: "manda red comita o contrato e o teste congelado antes do prove-red (o pinga procura o commit RED como base) e é idempotente ao rodar de novo"
touch:
  - src/red.ts
  - tests/red_real_pinga.test.ts
  - tasks/T907/PLAN.md
tests_frozen: ["tests/red_real_pinga.test.ts"]
done_when: "bun test tests/red_real_pinga.test.ts tests/red.test.ts tests/red_repo.test.ts tests/red_taken.test.ts tests/red_cli.test.ts tests/red_cli_repo.test.ts"
---
# T907: manda red com o pinga de verdade

- `pinga prove-red` acha a base pelo commit `test(T<N>): RED`. O `manda red`
  rodava o prove-red antes de comitar: com o pinga real saía "sem base para T1".
  Os testes existentes usam um pinga de mentira e não pegavam isso.
- Rodar de novo alocava outro id (T2) porque o T1 já estava no disco.
- Novo: comita, prova, e reaproveita o contrato já materializado com o mesmo goal.
