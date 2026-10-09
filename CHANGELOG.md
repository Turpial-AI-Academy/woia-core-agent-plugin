# Changelog

## 0.5.3 - 2026-10-06

- Add fenced Due Work contracts/transitions, durable cross-department delivery/activation/result/recovery, and organization resource resolution required by the approved B4 runtime contract.
- Add independently released orchestrator base+delta composition declarations/snapshots with provider-closure pinning while preserving existing closed v1 schemas and Core authority boundaries.

## 0.5.2 - 2026-10-05

- Add a generic fail-closed authority grant guard and prove Business Rules local-write cannot mutate without an exact grant.
- Bind local-write eligibility to current durable Project, Task, AgentInstance, AuthorityContext and exact scoped resource; provide a portable mandatory CLI with traversal and junction protection.

## 0.5.1 - 2026-10-04

- Enforce one native custom-agent thread per AgentInstance and root session, with independent run and receipt identities.
- Persist failure checkpoints, recover interrupted runtime state without sibling threads, and preserve generation and Project instruction boundaries.
- Remove unconsumed private authoring exports while preserving Core runtime and public contracts.
- Align maintenance documentation with the container-engine-neutral local parity contract.

## 0.5.0 - 2026-10-03

- Establish WOIA Core as a portable cross-department Agent Plugin.
- Extract provider/runtime orchestration mechanics from ASPS without software-specific phases.
- Carry forward lightweight Task/TaskCell, agent identity, evidence, effects, checkpoints and improvement semantics from WOIA Foundation.
- Add proportional OPEA-H workflow profiles for non-software work.
- Add Project overlays and effective capability snapshots so personalization survives plugin updates.
- Add S4 deterministic acceptance coverage, make pinned snapshot outputs immutable, and align `doctor` with the simplified archive-integrity contract.
