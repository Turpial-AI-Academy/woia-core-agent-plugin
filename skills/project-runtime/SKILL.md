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

## Project layout

.woia/project.json plus tasks/, task-cells/, agents/, bindings/, receipts/, effects/, checkpoints/, improvements/, overlays/, and snapshots/ contain durable Project-local operating state.

The Project stores operational state and references. It is not a replica of CRM/ERP/organization databases.

## Provider readiness

Track publication, discoverability, installation, enablement, and runtime load independently. enabled=true is desired state, not proof of installation or runtime load.

Authorization binds to the exact plugin/marketplace/selector/responsibility set. If that set changes, invalidate the earlier authorization rather than widening it silently.

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

## Evidence and failure

Every delegated run receives a root-issued run ID and returns dev.woia.execution-receipt/v1. Persist one receipt file per run.

Persist the first causal error and exact recovery. Distinguish provider-unavailable, runtime, authority, validation, external-system and unknown-effect failures.

Unknown effects are never automatically retried. Reconcile them first.

## Human boundaries

Ask only at genuine boundaries: exact provider installation authorization; credentials/access only the human can grant; approval/risk acceptance required by policy; consequential external effects; or a runtime restart/new session the host cannot create itself. Otherwise continue autonomously.
