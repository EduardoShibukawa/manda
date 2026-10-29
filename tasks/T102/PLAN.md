---
mode: padrao
goal: "manda lane: models do [supervisor] do project.toml e vigia de progresso comparando com o tick anterior (uma única mudança não zera o ocioso para sempre)"
touch:
  - src/pipeline.ts
  - tests/pipeline_vigia.test.ts
  - tasks/T102/PLAN.md
tests_frozen: [tests/pipeline_vigia.test.ts]
done_when: "bun test tests/pipeline_vigia.test.ts tests/pipeline_parity.test.ts tests/pipeline.test.ts"
---

# T102: follow-up do judge, TASK-14(b)
`loadSupervisorModels(root)` lê `[supervisor] models` de `.ginga/project.toml` (padrão
glm-5.3-flash-free, beam-free) e substitui o `models` fixo em `runPipelineImpl`. O vigia passa
a `hasRealProgress` o instante do tick anterior (não o início da rodada) como `sinceMs`.
