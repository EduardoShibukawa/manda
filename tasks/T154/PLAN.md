---
mode: mvp
goal: "manda aloca ids T<N> livres de forma determinística a partir do pinga queue e dos TASK-*.md, sem colisão entre PLANs"
done_when: "bun test tests/alloc.test.ts"
touch:
  - src/alloc.ts
  - tests/alloc.test.ts
  - tasks/T154/PLAN.md
tests_frozen: [tests/alloc.test.ts]
---

## Contexto
- A lista de ids tomados é injetada; o teste não chama o pinga.
- `allocTaskIds(taken, count)` devolve ids consecutivos a partir do maior `T<N>` válido.
- Ids não numéricos são ignorados e uma lista vazia começa em `T1`.
