---
mode: padrao
goal: "manda merge/judge/pipeline/lane recusam (exit 30) quando um ancestral é agente LLM (opencode run, pi, claude -p, codex exec), igual ao merge-gate.sh"
touch:
  - src/llm_guard.ts
  - src/judge_run.ts
  - src/cli.ts
  - bin/manda.ts
  - tests/llm_guard.test.ts
  - tasks/T101/PLAN.md
tests_frozen: [tests/llm_guard.test.ts]
done_when: "bun test tests/llm_guard.test.ts"
---

# T101: guarda de processo no manda
Novo `src/llm_guard.ts` com `findLlmAgent(pid, procRoot="/proc")` (lógica de
`insideLlmAgent`, movida de judge_run.ts, que reexporta). `cli.main(args)` recusa
merge|judge|pipeline|lane com JSON `{"error":"recusado..."}` e exit 30; `bin/manda.ts`
e o `import.meta.main` do cli usam `main`. `run()` segue sem guarda (testes in-process).
