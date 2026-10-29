---
mode: padrao
goal: "manda plan com o ginga lint real: só erro de frontmatter bloqueia (staging plano), prompt pede intent, suíte hermética quanto ao ginga do PATH"
touch:
  - src/plan.ts
  - tests/setup.ts
  - bunfig.toml
  - tests/plan_lint_real.test.ts
  - tasks/T114/PLAN.md
tests_frozen: [tests/plan_lint_real.test.ts]
done_when: "bun test tests/plan_lint_real.test.ts tests/plan_cmd.test.ts"
---

# T114: PLAN-0023 TASK-29, `manda plan` x `ginga lint` real
O staging é plano; o lint real é de bundle e acusa erros relacionais sempre. `runGingaLint` chama
`ginga lint <dir> --json`: em exit ≠ 0 só bloqueiam erros de frontmatter (`obrigatório`, `inválido: …`, campo
`frontmatter`); JSON ilegível em exit ≠ 0 segue inválido. O prompt pede `intent` no PLAN.md. `tests/setup.ts`
(preload de `bunfig.toml`) tira do PATH os diretórios com `ginga` para a suíte não depender do host.
