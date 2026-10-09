# WOIA Core

`woia-core` v0.5.7 supplies the shared operating contracts used by every WOIA department. Install the published plugin through the WOIA bootstrap or your department marketplace. Project customization belongs in Project overlays; installed plugin files remain immutable.

## Operating capabilities

- Project bootstrap, provider discovery and runtime readiness.
- Durable Tasks, TaskCells, checkpoints, execution receipts and recovery.
- Independent AgentDefinitions, AgentInstances and native runtime bindings.
- One native thread per AgentInstance and root session, with a new run and receipt for each delegation.
- Fail-closed capability, operation, effect and resource authority checks before provider mutations.
- Proportional non-software OPEA-H profiles; Software retains its own methodology.
- Immutable capability and orchestrator composition snapshots for in-flight Tasks.
- Organization-owned resource bindings, fenced Due Work and correlated cross-department delivery.
- Consumer overlays, self-evaluation and update compatibility reconciliation.

## Starting and resuming a Project

Invoke `woia-core:project-runtime` from the department Project. Follow its bootstrap and provider resolution contract, then observe the generation and role identities actually loaded by the host. Provider work requires matching loaded and materialized generations. A new host session is required after runtime or custom-role changes; a generated configuration alone does not establish readiness.

The root selects capabilities for each Task within the Project's stable departmental binding. Provider execution must use the required role, Task, AgentInstance, capability snapshot and authority scope. Reserve the native thread through Core before spawning; reuse its binding within the root session. On uncertain external effects, reconcile the durable effect record before retrying.

## Durable Project state

Core maintains `.woia/project.json` and the Project's `tasks`, `task-cells`, `agents`, `bindings`, `receipts`, `effects`, `checkpoints`, `improvements`, `overlays` and `snapshots` directories. These records contain operational state and organization references, not copies of organizational systems of record.

## Portable skills

- `woia-core:project-runtime`: bootstrap, runtime lifecycle, updates and continuation.
- `woia-core:opea-h`: proportional planning, execution, independent audit and human review.
- `woia-core:project-improvement`: improvement classification, overlays and compatibility reconciliation.

Core supplies contracts and deterministic transitions. Department orchestrators own methodology; provider plugins own capabilities; host adapters own transport and execution. Technical access never grants business authority.
