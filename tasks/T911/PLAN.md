---
mode: mvp
goal: "manda red e manda replan param de chamar pinga por nome fixo: o binário do gate vem de [commands].gate_cli do project.toml (padrão pinga)"
done_when: "bun test tests/gate_cli_config.test.ts tests/commands_config.test.ts"
touch:
  - src/project.ts
  - src/cli.ts
  - tests/gate_cli_config.test.ts
  - tasks/T911/PLAN.md
tests_frozen:
  - tests/gate_cli_config.test.ts
---

## Contexto
- `manda merge`, `run`, lint, lessons e cost já leem `[commands]`; `red` (fila e prove-red) e `replan` (fila) ainda tinham `["pinga", ...]` na CLI.
- `gate_cli` é o prefixo do comando (pode ter argumentos, ex.: `bun /caminho/pinga.ts`); o manda acrescenta os argumentos de sempre.
- Valor vazio ou config ilegível vale o padrão.
