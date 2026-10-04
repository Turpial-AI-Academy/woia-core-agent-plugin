# WOIA Core

`woia-core` is the cross-department operating core for WOIA v0.5.0.

It is deliberately **not** a department methodology and not a central backend. Department orchestrators such as `woia-software`, `woia-marketing`, and `woia-sales` use this plugin for shared operating mechanics.

## What Core owns

- one-invocation Project bootstrap and persistent root-agent binding;
- provider discovery/install/update/enablement/runtime-load lifecycle;
- durable Task and TaskCell state;
- proportional OPEA-H profiles for non-software persistent work;
- AgentDefinition / AgentInstance / HarnessRuntimeBinding separation;
- one native custom-agent thread per AgentInstance and root session, with new run/receipt identities for each delegation;
- execution receipts and evidence provenance;
- effect tracking, including unknown-effect reconciliation before retry;
- checkpoints, blockers, recovery and resume;
- self-evaluation and ImprovementCandidate generation;
- immutable-base Project overlays;
- effective capability snapshots for in-flight Task reproducibility.

## What Core does not own

- Software's 23 phases or Release Hygiene;
- Marketing/Sales methodology;
- provider capability implementation;
- organizational CRM/ERP/database records;
- source publication or marketplace governance;
- cross-department transport/data contracts (added by the organization-plane work).

## Consumer state

A WOIA-managed Project uses:

```text
.woia/
├── project.json
├── tasks/
├── task-cells/
├── agents/
├── bindings/
├── receipts/
├── effects/
├── checkpoints/
├── improvements/
├── overlays/
└── snapshots/
```

The Project stores operational state and references. It is not a copy of organizational systems of record.

## Portable skills

- `project-runtime` — bootstrap, provider/runtime lifecycle, custom-agent materialization, updates and continuation.
- `opea-h` — proportional Orchestration → Planning → Execution → Audit → Human Review.
- `project-improvement` — self-evaluation, improvement classification, overlays and update reconciliation.

## Core invariant

> Base plugins are immutable to consumers; project personalization is separate state; in-flight Tasks pin the effective capability they started with.
