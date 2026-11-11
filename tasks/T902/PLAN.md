---
mode: padrao
goal: "manda merge chama o gate de receipts e o pós-merge por [commands].gate e [commands].post_merge do project.toml; pinga vira só o valor padrão"
touch:
  - src/merge.ts
  - tests/merge_gate_plugavel.test.ts
  - tests/fixtures/merge/pinga-stub
  - tasks/T902/PLAN.md
tests_frozen: ["tests/merge_gate_plugavel.test.ts"]
done_when: "bun test tests/merge_gate_plugavel.test.ts tests/merge_gate.test.ts tests/merge_cleanup.test.ts tests/merge_revert_hook.test.ts tests/merge_followup.test.ts tests/merge_empty_pass.test.ts"
---
# T902: gate plugável no merge (fase 1, decisão do dono de 9/11)

- Saída 12: roda `[commands].gate` na worktree; padrão `pinga gate --root {worktree} {tasks}`.
- Saída 15: roda `[commands].post_merge` no trunk; padrão `pinga ledger verify`.
- `"none"` desliga o passo. Comando que não existe falha fechado (12 ou 15).
- Placeholders: `{tasks}`, `{worktree}`, `{repo}`, `{plan}`.
- A config vem do trunk (`<repo>/.ginga/project.toml`) e, se faltar, do bundle do PLAN.
- O stub de teste passa a responder `pinga gate` a partir do mesmo STUB_QUEUE_FILE.
