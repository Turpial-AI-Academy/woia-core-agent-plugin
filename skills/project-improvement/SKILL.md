---
name: project-improvement
description: Turn Task self-evaluation into safe WOIA Project personalization, organization-level proposals, or maintainer feedback while preserving immutable plugin bases and overlay compatibility across updates.
license: MIT
---

# WOIA Project Improvement

Every substantial Task/custom-agent execution should be able to learn without silently rewriting canonical WOIA plugins.

## Improvement loop

execution -> self-evaluation -> ImprovementCandidate -> classify target scope -> review -> local overlay / organization proposal / upstream feedback

An ImprovementCandidate is evidence, not automatic permission to modify anything.

## Target scopes

project: use when learning is specific to one Project/customer/team/workflow. Accepted local improvements become Project overlays under .woia/overlays/<plugin>/.

organization: use when learning should apply to multiple Projects/departments in the same organization. Record an organization-profile proposal through the organization's shared configuration path.

global-plugin: use when the finding is genuinely reusable for all plugin consumers. Consumers do not edit/publish upstream source. Record submitted-upstream and route it through Turpial AI Academy's external feedback channel. Only authorized maintainers/developers may implement/certify/release it.

## Base immutability

Never edit files inside an installed plugin to personalize it.

Effective behavior = base plugin release + organization profile + department profile + Project overlays.

An overlay may add instructions/preferences/resources; it must not impersonate a new upstream release or grant new authority.

## Overlay lifecycle

Each overlay records plugin identity, ID/revision/scope, declarative directives/resources, source ImprovementCandidates, last validated base version, compatibility status, and conflicts.

Compatibility is compatible, unverified, or conflict. Never delete a conflict just to make an update green.

## Update reconciliation

Preserve overlay bytes/revision first. Evaluate only changed plugin semantics intersecting the overlay. Compatible updates may compose a new effective capability. Unverified/conflicting updates keep the current effective capability for affected work until reconciliation succeeds.

## Effective capability snapshots

Persistent Tasks pin exact base plugin/version/selector, relevant profile revisions, overlay IDs/revisions, and a composed digest.

An update affects new Tasks by default. Existing Tasks keep their pinned snapshot unless explicitly migrated/rebound.

## Self-evaluation quality

Self-evaluation distinguishes what worked, what failed, remaining risks, concrete evidence, and candidate improvements. Do not generate improvement noise for trivial one-off preferences.

## Promotion boundary

No custom agent may commit to upstream WOIA repositories, tag/publish a plugin release, update the global registry/marketplaces, or globally promote its own candidate.
