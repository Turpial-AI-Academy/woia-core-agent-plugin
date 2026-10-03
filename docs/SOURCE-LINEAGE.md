# Source lineage

WOIA Core v0.5.0 is an extract-and-recompose refactor.

## WOIA Foundation

Source: Therenovatioai/woia-foundation

Carried forward as simplified contracts:

- Task as durable operational unit;
- TaskCell and proportional OPEA-H;
- AgentDefinition / AgentInstance / HarnessRuntimeBinding separation;
- evidence/receipt provenance;
- effect states including unknown;
- checkpoint/resume;
- ImprovementCandidate lifecycle.

Not carried forward:

- Foundation's monolithic package/runtime graph;
- central CLI/package resolver as a consumer dependency;
- the complete v0alpha1 object graph;
- workspace-local copies of organizational source databases.

## ASPS

Source: Turpial-AI-Academy/asps-agent-plugin

Carried forward as generic Core mechanics:

- one-invocation Project binding;
- provider readiness layers;
- ask-once exact-selector installation authorization;
- custom-role materialization and runtime-generation boundary;
- no root/provider fallback;
- one receipt per delegated run;
- steady-state fast path.

Not carried forward:

- Software's 23 phases;
- Release Hygiene;
- software profiles/contracts/provider mappings.

Those move to woia-software.
