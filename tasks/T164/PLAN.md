---
mode: padrao
goal: "Filtra TASKs por repo em redPlan, corrige erro de frozen ausente (caminho real) e grava status: blocked no lugar de blocked: true"
done_when: "bun test tests/red_repo.test.ts"
touch:
  - src/red.ts
  - tests/red_repo.test.ts
  - tasks/T164/PLAN.md
tests_frozen: [tests/red_repo.test.ts]
---

## Contexto
- Achado grave do judge (2026-10-30, ref TASK-03): redPlan itera todas as TASKs do bundle sem filtrar por repo; em PLAN multi-repo processa TASKs do ginga e aborta por tests_frozen ausente em frozen/manda. O erro de frozen/<repo> ausente lança caminho fixo tests/frozen.test.ts (não o caminho real). O bloqueio por test_passed_on_base grava blocked:true no frontmatter em vez de status: blocked. Testes passam só porque a fixture é toda repo: manda.
- RED em tests/red_repo.test.ts: (1) multi-repo — só TASKs do repo são processadas; (2) frozen ausente — erro contém o caminho real (frozen/<repo>); (3) test_passed_on_base — frontmatter tem status: blocked, não blocked: true.
- Fix: filtrar bundle.tasks por repo após loadBundle; remover o check de existência de frozenSrc e deixar a validação individual lançar srcPath (caminho real); trocar blocked: true por status: blocked.
- Não editar tests/red.test.ts, tests/red_cli.test.ts nem fixtures de T156/T159.
