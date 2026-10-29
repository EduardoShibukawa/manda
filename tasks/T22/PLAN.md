---
mode: padrao
goal: "Tornar determinístico o caso 10 do merge_gate (sentinela de HEAD diferente não colide com hash real)"
touch:
  - tests/merge_gate.test.ts
  - tasks/T22/PLAN.md
tests_frozen: [tests/merge_gate.test.ts]
done_when: "bun test tests/merge_gate.test.ts"
---

# T22: fix flaky hash collision no caso 10 do gate
Sentinela "0"+slice(1) colidia com HEAD quando o hash começava em 0.
Substituído por 40 'f' (hash impossível para commit real).