---
mode: padrao
goal: "manda lane: paridade 2 com lane.sh/lane.env — operador claude/*, operator/executor_models + [supervisor.env], cota esgotada (exit 4), sem progresso (exit 3), posicional de rodadas"
touch:
  - src/pipeline.ts
  - tests/pipeline_paridade2.test.ts
  - tasks/T113/PLAN.md
tests_frozen: [tests/pipeline_paridade2.test.ts]
done_when: "bun test tests/pipeline_paridade2.test.ts tests/pipeline_vigia.test.ts tests/pipeline_parity.test.ts tests/pipeline.test.ts"
---

# T113: PLAN-0023 TASK-23, paridade 2 do `manda lane`
(a) `claude/<m>` → `timeout 7200 claude -p --model <m> --permission-mode auto --output-format stream-json
--verbose --append-system-prompt lane:<nome> <prompt>`; (b) `operator_models` (cai em `models`),
`executor_models` → `MODELS` (separado por espaço) e `[supervisor.env]` no ambiente do operador;
(c) log < 6000 B com mensagem de cota → próximo modelo, todos esgotados → `.free-esgotado` + exit 4;
(d) rodada sem mudança de estado → exit 3; (e) `manda lane <repo> [rodadas]`.
