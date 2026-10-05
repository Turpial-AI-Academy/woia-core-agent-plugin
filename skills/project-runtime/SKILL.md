---
name: project-runtime
description: Bootstrap, resume, update, and operate a WOIA-managed ChatGPT/Codex Project while resolving provider plugins, materializing custom agents, preserving Project overlays, and enforcing runtime-generation and source-authority boundaries.
license: MIT
---

# WOIA Project Runtime

Use this skill when a department orchestrator needs to initialize or resume a WOIA Project, reconcile providers/custom roles, update installed capabilities, or recover runtime state.

## Core boundary

The root agent is the Project control plane. WOIA Core supplies mechanics; the department orchestrator supplies methodology; provider plugins own their capability work.

Never perform provider-owned fallback work because a provider is missing, failed, slow, or not loaded.

Consumers may install/update released WOIA artifacts and create Project-local state. They do not edit canonical WOIA source, marketplace source, tags, Releases, or upstream plugins.

## First explicit department invocation

An explicit request such as “use WOIA Marketing for this Project” authorizes normal Project-local WOIA setup, not external provider installation or consequential business effects.

Autonomously:

1. identify the Project/repository root and selected department orchestrator;
2. ensure .woia/ and its state directories exist;
3. merge the managed WOIA block into root AGENTS.md, preserving unrelated instructions;
4. initialize/reconcile .woia/project.json;
5. resolve the complete active primary-provider set from the department methodology;
6. establish exact immutable selectors from the configured department marketplace;
7. when providers are missing, present one complete ask_once installation plan and stop at that authorization boundary;
8. after authorization, perform supported safe installs directly and verify publication, discoverability, installation, enablement and runtime load separately;
9. merge Project plugin enablement/custom roles without replacing unrelated config;
10. when plugin/config/role inputs change, set runtime_restart_required and do not execute provider-owned work in the already-running process;
11. in a fresh runtime, verify the intended materialized generation is loaded before execution;
12. continue directly into department orchestration.

Do not make the user request these setup steps individually.

When command execution is available, prefer the bundled deterministic filesystem helper:

`node scripts/bootstrap-project.mjs --root <project-root> --project-id <id> --department <department> --orchestrator <plugin> [--organization-ref <ref>]`

It creates only WOIA-owned state directories, preserves unrelated root `AGENTS.md` instructions, reconciles only the managed WOIA block/state, and fails closed on Project identity conflicts.

Compatible Core patch updates preserve existing v1 Project state. When bootstrap observes a different installed Core patch, it updates `core_version`, advances materialization and requires a fresh loaded runtime; it does not reset Task/overlay state or treat old readiness as current.

WOIA manages exactly one `WOIA_PROJECT_OPERATING_CONTRACT` block in `<Project Root>/AGENTS.md`. Account/global instructions are loaded and owned by the host; do not locate or modify them. Preserve existing nested instruction files untouched; they are not WOIA state.

## Project layout

.woia/project.json plus tasks/, task-cells/, agents/, bindings/, receipts/, effects/, checkpoints/, improvements/, overlays/, and snapshots/ contain durable Project-local operating state.

The Project stores operational state and references. It is not a replica of CRM/ERP/organization databases.

## Provider readiness

Track publication, discoverability, installation, enablement, and runtime load independently. enabled=true is desired state, not proof of installation or runtime load.

Authorization binds to the exact plugin/marketplace/selector/responsibility set. If that set changes, invalidate the earlier authorization rather than widening it silently.

Before any provider-owned mutation/effect, prove a matching authority grant for the exact capability, operation, and effect class. Technical access is not authority. For local file persistence, the grant must include `local-write`; absence of a matching grant is a blocker and the provider must produce zero mutation. The bundled `scripts/authority-guard.mjs` provides the minimum fail-closed grant check; it does not waive separate denial, approval, or human-boundary rules.

## Runtime generations

Plugin enablement or custom-role materialization increments the materialized generation. Provider-owned work is executable only when loaded_generation equals materialized_generation and required provider skills/roles resolve.

Reuse this verification during the same loaded generation. Do not re-audit PluginStore/config/role files on every delegated turn.

## Steady-state continuation

When provider/runtime inputs are unchanged: read .woia/project.json once, identify the active Task/next responsibility, delegate to the exact role, validate/persist its receipt, update the Task delta/checkpoint, and continue.

Do not rerun bootstrap as ceremony.

## Plugin update flow

1. inspect the department marketplace through supported host behavior;
2. identify exact current and candidate base versions;
3. never change an in-flight Task's effective capability snapshot silently;
4. inspect applicable organization/department/Project overlays;
5. reconcile each overlay: compatible -> preserve and validate against candidate; unverified -> keep current effective version until validated; conflict -> preserve overlay, keep old effective capability for affected work, create reconciliation Task;
6. install/enable the authorized candidate;
7. require a fresh runtime generation;
8. compose new effective capabilities for new Tasks.

Never overwrite or delete an overlay to make an update succeed. Use the deterministic compatibility/snapshot helpers from `project-improvement` before composing a new Task capability pin.

## Custom-agent materialization

A generated role contains Task/responsibility identity, exact primary provider plugin/version/skill, explicit $skill invocation, effective capability snapshot reference, authority/resource scope, receipt contract, and common error/self-evaluation/improvement rules.

Role files are harness projections, not canonical AgentInstances.

## Root-session custom-agent lifecycle

Core owns this invariant for every department: **one AgentInstance + one active root session has at most one native custom-agent thread**. AgentDefinition is not the singleton key. Independent AgentInstances may share a definition, but never a native thread. Software consumes this same lifecycle without OPEA-H wrapping; Development, Code Review, Testing, Security and Release QA remain independent when applicable. OPEA-H Executor and Auditor also remain independent, while repeated runs of either reuse that agent's singleton.

At root-session entry, use the observed host root-session identifier. If the host exposes no suitable identity, explicitly start a session once to issue a random runtime token. Store/resolve that token in `.woia/runtime/current-session.json`, not conversational memory or canonical Project identity. Runtime/session files describe a local harness session; they are not portable Project truth. Observe the actually loaded generation in this root session rather than trusting a prior session's persisted readiness.

The bundled `scripts/agent-thread-lifecycle.mjs` implements the local transition protocol. It uses only Node built-ins and does not create or inspect host threads itself. Call it as `node scripts/agent-thread-lifecycle.mjs <operation> <input.json>`; each input supplies `root` and the operation's fields:

1. `startSession`: `sessionId` from the host (omit only to generate an ephemeral token), and `loadedGeneration` observed in this runtime. Repeated calls with the same identity cannot change its generation; closed identities cannot be reactivated.
2. `prepareDelegation`: resolve `agentId` to an existing AgentInstance, then its current `sessionId` binding, validate generation, and inspect the thread. Supply observed `harness: {type, version}` on first activation and `threadStatus: "usable"` on reuse.
3. Only `CREATE_THREAD` permits a first native creation. The binding reservation is already persisted. Invoke the host's native custom-agent creation once with instructions to wait for a root-issued run before doing provider work, then call `bindThread` with `sessionId`, `agentId`, the reserved `bindingId`, and observed `threadId`. `WAIT_FOR_THREAD` is not permission to create again; reconcile the already requested creation. If its outcome is unknown, call `failThread` and require a fresh root session.
4. Call `prepareDelegation` again. Only `DELEGATE` permits execution, using its existing binding/thread and fresh `run.id`/`run.receipt_id`. Send subsequent work to that same native custom-agent thread. `WAIT_FOR_RUN` waits for the existing run's receipt rather than starting concurrent work on the same thread.
5. Validate the returned receipt against `dev.woia.execution-receipt/v1`, then call `recordReceipt` with `receipt`. Its identity/generation must match the issued run. Persist one immutable receipt per run. Finishing a run never releases/archives/closes the native thread.
6. For an unusable, lost, host-rejected, capacity-blocked or irrecoverable singleton, call `failThread` with the exact `reason`. Persist blocker/checkpoint/continuation, including existing unknown-effect reconciliation requirements. Do not create remediation/reverify/final/fix sibling AgentInstances to evade the singleton. Recover from a fresh root session after reconciling the Task's blockers.
7. `closeSession` retires current bindings and clears active references. Starting S2 also retires an observed S1 session, preserving Project, Tasks, logical AgentInstances, receipts/effects/checkpoints/overlays/snapshots. S2's first activation creates B2/T2 lazily; subsequent S2 runs reuse B2/T2. B1/T1 never become current in S2.

Bindings record AgentInstance, root session, native thread, generation and state. Legacy v1 bindings without a root-session identity remain readable as history, but are ineligible for current execution. `AgentInstance.active_binding_ref` points only to a usable current-session binding. Local transitions are serialized; interrupted reservations fail closed. Never remove runtime records/locks or invent another session token to bypass a failure within the same real root session.

If the local helper process exits while holding a lifecycle lock, `recoverAbandonedLock` is an explicit recovery operation for a **new real root session**. Supply its new `sessionId` (or retain the newly issued token). Recovery verifies the recorded process is absent on the same host; a live/reused PID, access error or different host remains blocked. A recovery marker prevents further S1 operations. Then `startSession` with that exact new identity completes interrupted blockers/checkpoints before retiring S1. A repeated recovery continues its recorded target, including an abandoned recovery operation; do not remove lock files manually. Filesystem failures may leave a reservation incomplete: retrying `prepareDelegation` or `failThread` completes the same blocker/checkpoint rather than granting another creation.

The helper proves the deterministic source contract. Native thread creation, identity, usability, session boundaries and loaded-generation observations must be verified through the real host during Operator E2E; local simulations do not prove host behavior.

## Evidence and failure

Every delegated run receives a root-issued run ID and returns dev.woia.execution-receipt/v1. Persist one receipt file per run.

Persist the first causal error and exact recovery. Distinguish provider-unavailable, runtime, authority, validation, external-system and unknown-effect failures.

Unknown effects are never automatically retried. Reconcile them first.

## Human boundaries

Ask only at genuine boundaries: exact provider installation authorization; credentials/access only the human can grant; approval/risk acceptance required by policy; consequential external effects; or a runtime restart/new session the host cannot create itself. Otherwise continue autonomously.
