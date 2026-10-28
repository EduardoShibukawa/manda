---
type: policy
title: Roteamento de fixture (alt)
ladder:
  - {tier: free, tries: 2}
  - {tier: medium, tries: 2}
  - {tier: strong, tries: 1}
breaker: {same_reason: 3, ignore: [quota_exhausted, infra]}
pools:
  executor:
    free: [opencode/nemotron-3-ultra-free, opencode/mimo-v2.6-flash-free]
    medium: [opencode/glm-5.3]
    strong: [codex/gpt-6-luna]
  verifier_judge:
    default: [agy/gemini-4-argon, codex/gpt-6-luna]
budget: {month_usd: 10, task_usd: 0.25, plan_usd: 1.5, warn_pct: 80}
ask_owner: [over_cap, runtime_claude]
---
## Fixture

Frontmatter equivalente às tabelas do ROUTING.md real; este corpo só existe para o parser.
