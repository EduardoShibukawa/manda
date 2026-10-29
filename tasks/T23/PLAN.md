---
mode: padrao
goal: "Paridade do manda lane com .ginga/bin/lane.sh: prompt gerado do estado, vigia de progresso real por pid, abort exit 20 se main andar, heartbeat.progress efeito real"
touch:
  - src/pipeline.ts
  - tests/pipeline_parity.test.ts
  - tasks/T23/PLAN.md
tests_frozen: ["tests/pipeline_parity.test.ts"]
done_when: "bun test tests/pipeline_parity.test.ts"
---

# T23: paridade manda lane com lane.sh (PLAN-0023)
