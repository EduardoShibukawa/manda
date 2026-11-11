---
mode: padrao
goal: "a máquina de estados do PLAN mora no manda: manda next lê o estado em JSON e devolve a próxima ação (red, run, judge, merge, replan, notify, none), sem LLM"
touch:
  - src/next.ts
  - src/cli.ts
  - tests/next.test.ts
  - tasks/T909/PLAN.md
tests_frozen: ["tests/next.test.ts"]
done_when: "bun test tests/next.test.ts tests/cli.test.ts"
---
# T909: manda next (decisão do dono de 9/11: a máquina fica no manda)

- A visão 02 põe transições, retries e orçamento de um run no orquestrador.
  Hoje a regra vive em `g-inga/src/tick_plan.ts`.
- `manda next` é função pura: estado entra por stdin, ação sai em uma linha de JSON.
  O ginga continua dono da fila, do lease e de gravar a fase no state.db.
- Mesmas regras de hoje, mais uma: veredito `fail` do judge leva a replan.
