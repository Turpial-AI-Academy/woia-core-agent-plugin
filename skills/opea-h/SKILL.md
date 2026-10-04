---
name: opea-h
description: Run proportional non-software WOIA Tasks using Orchestration, Planning, Execution, Audit, and Human Review while preserving role independence, evidence, authority, and Task continuity.
license: MIT
---

# OPEA-H

OPEA-H is the default semantic operating model for persistent non-software WOIA work: Orchestration -> Planning -> Execution -> Audit -> Human Review.

It is proportional, not ceremonial, and does not require five concurrent model sessions.

## Do not wrap Software

If the selected department orchestrator declares software-methodology, hand control to that methodology. Do not add redundant OPEA-H around Software phases.

## Profile selection

- direct-service: orchestration -> response; use for ephemeral help with no durable Task.
- task-execution: orchestration -> execution -> human review when required.
- planned-execution: orchestration -> planning -> execution -> human review when required.
- audited-execution: orchestration -> execution -> audit -> human review when required.
- opea-h-full: orchestration -> planning -> execution -> audit -> human review.

Planning is justified by ambiguity, multiple dependencies, meaningful sequencing, strategy choice, or high rework cost.

Audit is justified by external/public/financial/security/legal/high-consequence effects, important data mutation, policy compliance, separation of duties, or an explicit deliverable contract.

Human Review is required when policy/effect authority says so and for opea-h-full. Do not autoapprove it.

## Task creation

Persistent work creates one Task, one TaskCell, logical AgentInstances for required roles, and runtime bindings only when the host materializes threads/custom agents.

The Task owns objective, scope, constraints, expected outputs, evidence requirements, lifecycle, owner, blockers, checkpoint and effective capability snapshots.

## Role responsibilities

Orchestrator: classify profile, create/resume TaskCell, establish authority/snapshots, invoke phases, validate receipts, coordinate human boundaries, never replace provider work.
Planner: define the smallest actionable plan, resources/dependencies and evidence without broadening scope.
Executor: perform authorized provider work, record outputs/effects/evidence, then self-evaluate.
Auditor: remain independent from Executor identity/thread and inspect actual evidence, not prose assertions.
Human Reviewer: approve/reject/request change where required and remain outside agent self-approval.

## Receipts and continuity

Every delegated phase run has a new run ID and receipt ID. The Core `project-runtime` lifecycle requires the same AgentInstance to reuse its binding/thread throughout the root session. Executor and Auditor remain independent AgentInstances/threads; a second Auditor run reuses that Auditor's thread. Consume Core's failure/session-rollover rules rather than implementing another lifecycle.

Persist only durable state/evidence required for continuation. Conversation history and chain-of-thought are not Task state.

## Audit cycles and fast path

Default maximum audit/remediation cycles: 3. At the limit, block, replan or escalate instead of looping indefinitely.

A bounded revision fast path is allowed only when the selected profile permits it and scope, authority, effects, and deliverable contract remain unchanged. It never waives required evidence.

## Closure

Before completion verify outputs/evidence, resolve or explicitly block unknown effects, obtain required Human Review, persist final receipt/checkpoint, run self-evaluation/create justified ImprovementCandidates, and mark the Task terminal with no next action.
