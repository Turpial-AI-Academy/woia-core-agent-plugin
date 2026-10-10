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

Compatible Core patch updates preserve existing v1 Project state. When bootstrap observes a different installed Core patch, it uses the shared capability transition: check exact Task pins, overlays, native runs and pending effects; update `core_version`; advance materialization; clear `loaded_generation`; retire current runtime bindings and require a fresh loaded runtime. A changed in-flight pin or unresolved effect blocks the update before state changes. Bootstrap also uses the shared lifecycle fence and byte comparison when reconciling the same version.

WOIA manages exactly one `WOIA_PROJECT_OPERATING_CONTRACT` block in `<Project Root>/AGENTS.md`. Account/global instructions are loaded and owned by the host; do not locate or modify them. Preserve existing nested instruction files untouched; they are not WOIA state.

## Project layout

.woia/project.json plus tasks/, task-cells/, agents/, bindings/, receipts/, effects/, checkpoints/, improvements/, overlays/, and snapshots/ contain durable Project-local operating state.

The Project stores operational state and references. It is not a replica of CRM/ERP/organization databases.

## Provider readiness

Track publication, discoverability, installation, enablement, and runtime load independently. enabled=true is desired state, not proof of installation or runtime load.

Authorization binds to the exact plugin/marketplace/selector/responsibility set. If that set changes, invalidate the earlier authorization rather than widening it silently.

Before any provider-owned mutation/effect, prove a matching authority grant for the exact capability, operation, and effect class. Technical access is not authority. For local file persistence, the grant must include `local-write`; absence of a matching grant is a blocker and the provider must produce zero mutation. Immediately before local file persistence, the consumer must execute the installed Core helper below (or call its exported `requireLocalWrite` with the same inputs), check successful exit and `allowed: true`, and use the returned exact target. A failure blocks all creation/modification; analysis and proposed content may proceed where permitted. This eligibility check does not waive separate denial, approval, runtime-generation, effect-reconciliation, or human-boundary rules. It never writes the artifact.

```text
node <installed-core-root>/skills/project-runtime/scripts/authority-guard.mjs --project-root <current-project-root> --request <request.json>
```

The request contains `projectId`, `principalId`, `department`, `taskRef: {kind: "Task", id, revision}`, `agentRef: {kind: "AgentInstance", id, revision}`, `capability`, `operation`, `effectClass: "local-write"`, `target` (an exact Project-relative file path), and `resourceRef: {type, id, uri: target}` with `version` when the scoped resource has one. Resolve the installed Core root through the current provider/runtime binding; do not assume a machine-specific installation path.

The helper reads the current `.woia/project.json` and Project-owned records in `.woia/tasks/*.json`, `.woia/agents/*.json`, and `.woia/authority-contexts/*.json`. AuthorityContext records retain `dev.woia.authority-context/v1`; the latter directory is their durable location, not a new authority schema. The AgentInstance must reference the current AuthorityContext with `kind: "AuthorityContext"`, identity and revision. Task refs use `kind`, not resource refs' `type`. Missing, stale, ambiguous, or cross-Task references deny eligibility. The Project/department must match, Task and AgentInstance must be active, and Task blockers must be empty.

The target must be listed exactly in the Task's `expected_outputs` and in the AgentInstance's `resource_scope` with the same resource identity, URI, and optional version. These records are authored by the authorized orchestrator/operator; a provider must not broaden them or create a grant to authorize its own pending write. Absolute paths, traversal, Windows alternate/device paths, and symlink/junction targets or ancestors are denied. Recheck against fresh records immediately before the operation if any state or target changes; eligibility is not a reusable permission token or an OS filesystem sandbox. Nonempty opaque v1 `denials` remain fail-closed without interpreting their strings as a new policy language.

## Runtime generations

Plugin enablement or custom-role materialization increments the materialized generation. Provider-owned work is executable only when loaded_generation equals materialized_generation and required provider skills/roles resolve. The local-write guard reads the current active harness binding and root-session observation as well as the authority grant; a historical binding cannot authorize a write after an update.

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

## Global runtime prerequisites

Core defines portable global operating semantics without becoming a central backend or transport service.

### Due Work

Use `dev.woia.due-work/v1` for a durable organization-hosted due occurrence. The stable `dedupe_key` identifies one subject/rule/period occurrence. Workers claim with an incrementing fence and expiring token; stale claims cannot complete work. A wake only creates/resumes/evaluates work and never grants business authority. The deterministic reference transition helper is `due-work-state.mjs`; the physical durable store/worker belongs to the selected Technology/runtime implementation.

Every claim-owned mutation requires a current token/fence and an observation time inside the claim's interval (expiry is exclusive). Block/retry retains the same occurrence and existing Task identity; `attachDueWorkTask` cannot replace it with another Task. The durable store still owns atomic revision/fence comparison and occurrence uniqueness.

### Autonomous cross-department delivery

The existing typed request/response remains the business protocol. `dev.woia.cross-department-delivery/v1` adds a durable delivery record with distinct queued → claimed → submitted → delivered → activated → accepted → result-returned → completed states. A submitted call with unknown outcome becomes `transport-unknown`; it may be retried only after reconciliation proves it was not delivered. Receiver activation failure becomes an owned blocker. Receiver acceptance creates/resumes a distinct receiver-owned Task; transport ACK is not acceptance or completion.

Use `createDeliveryResponse` to construct a typed response from the delivery's request/correlation and receiver-owned Task. Persist that response separately, then supply both its `CrossDepartmentResponse` reference and actual response to `acceptDelivery` (`acceptanceResponse`), `returnDeliveryResult` or `rejectDelivery` (`response`). Transitions verify status, request/correlation, destination Project/department and Task identity. Acceptance acknowledgement and terminal result require distinct references; an accepted acknowledgement cannot complete delivery. The receiver evaluates its own authority separately; no sender authority enters the generated response or delivery identity.

Harness adapters such as Project Bridge implement transport/activation when the host supports it. Core defines correlation/recovery semantics; it does not pretend an unsupported host can activate another Project. No human copy/paste or external-person message is a successful transport fallback.

### Organization resource binding

Organization data/policy/domain resources remain outside the Project. A selected organization integration supplies `dev.woia.organization-resource-binding-set/v1`. Core resolves only the entries allowed for the Project's department + purpose into an immutable `dev.woia.project-resource-resolution/v1` reference snapshot. The snapshot contains resource/binding references and minimum fields/operations, never credentials or a copied organization database. The current closed Project v1 schema is not privately extended; linked binding records live under the existing bindings/runtime mechanism.

Both resolver entrypoints require the authenticated expected `organizationRef`; the file entrypoint must never infer it from the file being checked. Closed binding/contract/reference fields and strictly valid effective dates fail closed before filtering; mutable organization references are copied by value. Each resolution's digest pins its versioned minimum view; persist it under a distinct immutable snapshot identity.

### Independent base + delta composition

A vertical specialization is activated only from a qualified Ecosystem `dev.woia.orchestrator-specialization/v1` declaration. Core creates `dev.woia.orchestrator-composition-snapshot/v1` only when the exact base version is inside the declared range, the exact base/delta pair has passed evaluation, and the actual provider closure matches that evaluated pair. The delta is the one active root; the generic base is a dependency, not a competing root. In-flight Tasks keep the exact snapshot. Unsupported upgrades block instead of silently rebinding.

New evaluated tuples also pin Core through `core_version` in the admitted declaration and `coreVersion`/`coreSelector` in the snapshot constructor. Historical snapshots remain immutable; they cannot supply a new specialization context without that evaluated Core pin.

### Trusted specialization context

Use [specialization-context.mjs](scripts/specialization-context.mjs) to resolve `dev.woia.specialization-context/v1`. `loadSpecializationContext({root, taskRef, bindingRef, requiredSlots, requiredDescriptorIds})` reads the fixed Project-owned Tasks, snapshots, specialization bindings, accepted domain descriptors, current domain sources and specialization policies. `createSpecializationContext` is the pure equivalent for a host that has independently resolved those records. Request payloads cannot provide module paths, accepted bindings or policies.

The resolver verifies the active root, exact base/delta/Core/provider pins, current Task and Project scope, loaded generation, exported slots, policy revisions and descriptor content hashes. The base, delta and provider closure must be installed, enabled and loaded in the current Project inventory. Missing or stale specialization blocks; it never changes the requested work into a generic fallback.

Domain providers own the descriptor schemas and their semantics. Core accepts a generic envelope with `status: ACCEPTED_CURRENT`, `source_ref`, an exact opaque source `revision`, a raw 64-character `digest_sha256` and `descriptor`. The digest is SHA-256 over canonical JSON with sorted object keys and preserved array order. A separately resolved current domain source must match that source, revision and digest. Core does not mark a source accepted or current from conversational claims.

`permitted_actions` and `permitted_outcomes` are the intersection of the admitted base, organization, delta and provider policies. This context narrows available business actions; the provider still checks its exact authority, approval, persistence and effect controls before dispatch. Department methodology and domain fact acceptance stay in their owning plugins.

### Installation transitions

Global owns distribution selection, installation locks, host projections and migration proof. Core owns Project lifecycle through [capability-update.mjs](scripts/capability-update.mjs):

```text
node <installed-core-root>/skills/project-runtime/scripts/capability-update.mjs --root <Project-root> --expected-generation <current-generation> --expected-project-sha256 <exact-project-file-hash> --binding <staged-installation-binding.json> --core-version <installed-Core-version>
```

`previewCapabilityUpdate` performs the same preflight without writing. `applyInstallationBindingUpdate` shares the native-thread lifecycle lock, compares the current Project bytes and generation, and rejects unresolved effects, running native runs, unavailable in-flight pins or incompatible overlays. It preserves Task, snapshot and overlay bytes. On success it clears all load observations, retires current bindings, refreshes the selected provider inventory and requires a new root session. Global publishes its installation binding within its own guarded activation transaction.

Existing external roles remain present or cause a reconciliation conflict. Removing historical managed roles requires an immutable verified Global migration receipt whose byte hash is pinned by the staged binding. Pass that receipt using `--migration-receipt`; its Project byte hash, lock hash and ownership records must match the transition. Installation and load remain separate states. A prepared projection is not a live host observation.

Selectors must be the exact `v<version>` tag or an immutable commit SHA already qualified through Ecosystem; Core does not re-run release admission. Declaration semantics and evaluation evidence must be non-empty correctly typed arrays. The file writer atomically creates the snapshot without replacement: competing writers with different semantics cannot overwrite an in-flight Task's winner.

These linked records deliberately avoid adding private fields to existing closed v1 Project, Task, OrganizationRegistry or EffectiveCapabilitySnapshot schemas. Business/domain data transactions remain separate from Core filesystem state and remote effects.
