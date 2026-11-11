---
mode: padrao
goal: "manda run trabalha na branch do PLAN quando ela existe: a TASK parte de plan/NNNN e volta para ela, sem tocar a main; o gate ganha o placeholder {gate_id}"
touch:
  - src/run.ts
  - src/worktree.ts
  - src/gate.ts
  - tests/run_plan_branch.test.ts
  - tasks/T905/PLAN.md
tests_frozen: ["tests/run_plan_branch.test.ts"]
done_when: "bun test tests/run_plan_branch.test.ts tests/run.test.ts tests/worktree_gate.test.ts"
---
# T905: manda run na branch do PLAN (condutor único, fase 3)

- Hoje o `manda run` mergeia cada TASK direto na main, sem judge nem merge-gate.
- Com worktree de `plan/NNNN` no repo da TASK (criada pelo `manda red`), a TASK
  nasce dessa branch e o resultado é mergeado nela; a main só anda pelo `manda merge`.
- Sem branch do PLAN, vale o comportamento antigo.
- `{gate_id}` em `[commands].verify` é o `pinga_task` do frontmatter da TASK (gate.ts não cita o pinga).
