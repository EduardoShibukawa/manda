---
mode: padrao
goal: "Revert automático do merge (exit 14) usa MERGE_GATE=1 e retorna 16 (CRÍTICO) se falhar, compatível com o hook reference-transaction do ginga"
touch:
  - src/merge.ts
  - tests/merge_revert_hook.test.ts
  - tasks/T100/PLAN.md
tests_frozen: [tests/merge_revert_hook.test.ts]
done_when: "bun test tests/merge_revert_hook.test.ts"
---

# T100: revert do merge-gate respeita MERGE_GATE e hook reference-transaction
O revert em src/merge.ts rodava sem MERGE_GATE=1 e era bloqueado pelo hook
reference-transaction do ginga (exit 16). Passa env MERGE_GATE=1; falha no
revert vira exit 16 (CRÍTICO), não 14.
