---
mode: padrao
goal: "manda merge: TASK do diff ausente da fila do pinga conta como pendente (exit 12); falha no git revert não é ignorada (exit != 0, com aviso)"
touch:
  - src/merge.ts
  - tests/merge_followup.test.ts
  - tasks/T18/PLAN.md
tests_frozen: ["tests/merge_gate.test.ts"]
done_when: "bun test tests/merge_followup.test.ts tests/merge_gate.test.ts"
---
# T18: follow-up judge (PLAN-0022) — ausência na fila + revert não ignorado

Materializada de `.ginga/plans/PLAN-0022-merge-gate-no-pacote/TASK-05-merge-gate-followup-judge.md`.
