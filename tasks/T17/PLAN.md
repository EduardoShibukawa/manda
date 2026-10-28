---
mode: padrao
goal: "Corrigir erros de autoria em tests/merge_gate.test.ts (T16) que nenhum gate fiel a merge-gate.sh passa: veredicto desatualizado em 13, commit faltante em 14, wtHead() após remover worktree em 2a"
touch:
  - tests/merge_gate.test.ts
  - tasks/T17/PLAN.md
tests_frozen: ["tests/merge_gate.test.ts"]
done_when: "bun test tests/merge_gate.test.ts"
---
# T17: correção dos testes congelados do gate (PLAN-0022)

Referência executável: `.ginga/bin/merge-gate.sh` (veredito sobre o HEAD exato).
- Teste 13: veredito desatualizado; o intent exige veredito sobre o estado final da branch.
- Teste 14: falta o commit de `tests/needs_helper.test.ts` ("a branch comita um teste").
- Teste 2a: `wtHead()` depois de remover a worktree (ENOENT; conteúdo irrelevante para 2).
Edição por executor OpenCode dentro da TASK: o prompt do executor despachado não
altera tests_frozen (regra: TASK nova com teste novo).
