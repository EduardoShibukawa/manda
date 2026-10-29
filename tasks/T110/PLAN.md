---
mode: padrao
goal: "manda merge recusa com exit 17 (passe vazio) um veredito pass sem itens, igual ao merge-gate.sh"
touch:
  - src/merge.ts
  - tests/merge_empty_pass.test.ts
  - tasks/T110/PLAN.md
tests_frozen: [tests/merge_empty_pass.test.ts]
done_when: "bun test tests/merge_empty_pass.test.ts tests/merge_gate.test.ts tests/merge_followup.test.ts tests/merge_revert_hook.test.ts"
---

# T110: exit 17 no manda merge
Veredito com 0 itens para o repo (ou sem `judge.items`) → exit 17, depois do 10 e antes do 11.
As fixtures `writeVerdict` dos 3 testes de merge antigos passaram a ter 1 item por padrão (commit do RED).
