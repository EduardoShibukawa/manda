---
mode: padrao
goal: "manda red não repete um id de TASK já usado por outro PLAN do bundle: dois PLANs abertos no mesmo repo ganham ids diferentes"
touch:
  - src/red.ts
  - tests/red_ids_entre_plans.test.ts
  - tasks/T910/PLAN.md
tests_frozen: ["tests/red_ids_entre_plans.test.ts"]
done_when: "bun test tests/red_ids_entre_plans.test.ts tests/red_real_pinga.test.ts tests/red.test.ts tests/red_repo.test.ts tests/red_taken.test.ts tests/red_cli.test.ts tests/red_cli_repo.test.ts"
---
# T910: colisão de id entre PLANs (mesma classe do T325)

- O red olhava só os `pinga_task` do PLAN atual e os `tasks/T*` da worktree
  recém-criada da main. O id que outro PLAN aberto alocou vive só na branch dele.
- Dois PLANs no mesmo repo recebiam o mesmo T<N>; o receipt `blocked` de um
  travava o outro na fila.
- Novo: os `pinga_task` de todas as TASKs de todos os PLANs do bundle contam como usados.
