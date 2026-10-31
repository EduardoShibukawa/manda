---
mode: padrao
goal: "CLI manda red funciona em PLAN multi-repo herdando o filtro por repo de redPlan"
done_when: "bun test tests/red_cli_repo.test.ts"
touch:
  - tests/red_cli_repo.test.ts
  - tasks/T171/PLAN.md
tests_frozen: [tests/red_cli_repo.test.ts]
---

## Contexto
- Achado do judge (2026-10-30, simples; ref TASK-09): a CLI manda red chama redPlan e valida tests_frozen, mas herda a falta de filtro por repo: PLAN multi-repo falha com arquivo ausente de TASK de outro repo.
- RED em tests/red_cli_repo.test.ts: PLAN com TASKs de dois repos, manda red --repo manda processa só as do manda e devolve JSON com as TASKs corretas. Sem o filtro de redPlan (T170) o CLI falha porque tenta validar frozen de outro repo.
- Fix: herdado de T170 (src/red.ts). A CLI já passa repo: repoArg a redPlan; sem mudança em src/cli.ts.
- Não editar tests/red_cli.test.ts.
