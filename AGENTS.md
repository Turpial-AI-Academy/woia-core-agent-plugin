# AGENTS.md — WOIA Core

## Repository mission

Maintain the portable cross-department WOIA Core without absorbing department-specific methodology or provider capability logic.

## Invariants

1. Core is a plugin, not a central service.
2. Only authorized Turpial AI Academy WOIA maintainers/developers modify canonical source or publish versions.
3. Consumers install/update Core; consumers do not patch Core source for Project personalization.
4. Department methodology stays outside Core.
5. Provider implementation stays in provider plugins.
6. Project state is durable, minimal and reconstructible without conversational history.
7. OPEA-H is proportional; do not create five-agent ceremony for simple work.
8. Software uses its own `woia-software` methodology rather than redundant OPEA-H wrapping.
9. AgentDefinition, AgentInstance and HarnessRuntimeBinding remain distinct.
10. Tool/plugin visibility does not grant business authority.
11. Unknown external effects are reconciled before retry.
12. Improvement candidates never self-publish upstream changes.
13. Overlays never edit installed base plugin files.
14. Plugin updates preserve overlays or block with a reconciliation conflict.
15. In-flight Tasks pin effective capability snapshots.
16. Runtime/plugin/custom-role changes require a fresh loaded generation before provider-owned execution.
17. The root orchestrator does not silently perform provider-owned fallback work.
18. Validation is proportional and protects behavioral contracts rather than prose.
