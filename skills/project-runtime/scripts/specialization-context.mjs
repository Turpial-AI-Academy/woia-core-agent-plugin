import {createHash} from "node:crypto";
import {readFile, readdir} from "node:fs/promises";
import path from "node:path";
import {requireSelector, requireStrings, requireTaskRef} from "./b4-contract.mjs";

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const SHA = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const POLICY_ROLES = ["base", "organization", "delta", "provider"];
const sourceRevision = value => typeof value === "string" && value.trim().length > 0 || Number.isSafeInteger(value) && value >= 1;
const validScope = value => typeof value === "string" && value.trim().length > 0 || value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

export const descriptorDigest = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);

function pin(value, label) {
  assert(value && typeof value.plugin === "string" && value.plugin && SEMVER.test(value.version), "Invalid exact " + label + " pin");
  requireSelector(value.selector, value.version);
  return {plugin: value.plugin, version: value.version, selector: value.selector};
}

function closure(values) {
  assert(Array.isArray(values), "Provider closure is required");
  const pins = values.map(value => pin(value, "provider"));
  assert(new Set(pins.map(value => value.plugin)).size === pins.length, "Provider closure contains duplicate plugin identities");
  return pins.sort((left, right) => left.plugin.localeCompare(right.plugin));
}

export function validateCompositionSnapshot(snapshot) {
  assert(snapshot?.schema === "dev.woia.orchestrator-composition-snapshot/v1", "Qualified composition snapshot is required");
  const {schema, id, composed_digest, created_at, ...identity} = snapshot;
  assert(SHA.test(composed_digest) && composed_digest === "sha256:" + descriptorDigest(identity), "Composition snapshot content digest mismatch");
  assert(id === "orchestrator-snapshot:" + snapshot.task_ref?.id + ":" + composed_digest.slice(7, 19), "Composition snapshot identity mismatch");
  assert(SHA.test(snapshot.declaration_digest), "Snapshot declaration digest is required");
  requireTaskRef(snapshot.task_ref, "snapshot.task_ref");
  const base = pin(snapshot.generic_base, "base"), delta = pin(snapshot.delta, "delta");
  assert(base.plugin !== delta.plugin && same(pin(snapshot.active_root, "active root"), delta), "Delta must be the one active root");
  closure(snapshot.provider_closure);
  if (snapshot.core) assert(pin(snapshot.core, "Core").plugin === "woia-core", "Snapshot Core pin identity mismatch");
  for (const field of ["allowed_operations", "exported_slots", "required_gates", "evaluation_evidence"]) requireStrings(snapshot[field], field, {nonEmpty: true, unique: true});
  assert(snapshot.allowed_operations.every(value => ["ADD", "SPECIALIZE", "NARROW"].includes(value)), "Composition operation broadens the generic base");
  return snapshot;
}

function intersect(lists) {return lists[0].filter(value => lists.every(list => list.includes(value))).sort();}

/** Consume records resolved by the trusted host. Request payloads are never inputs to this resolver. */
export function createSpecializationContext({snapshot, project, taskRef, binding, descriptors = [], domainSources = [], policies, requiredSlots = [], requiredDescriptorIds = []}) {
  validateCompositionSnapshot(snapshot);
  requireTaskRef(taskRef, "taskRef");
  assert(Number.isSafeInteger(taskRef.revision) && taskRef.revision >= 1, "Current Task revision is required");
  assert(project?.schema === "dev.woia.core-project-state/v1", "Current Core Project is required");
  assert(binding?.schema === "dev.woia.specialization-binding/v1" && binding.status === "active", "Current specialization binding is required; generic fallback is forbidden");
  assert(typeof binding.id === "string" && binding.id && Number.isSafeInteger(binding.revision) && binding.revision >= 1, "Specialization binding identity/revision is required");
  assert(binding.project_ref === project.project.id && binding.department === project.project.department
    && binding.project_ref === snapshot.project_ref && binding.department === snapshot.department, "Specialization Project/department scope mismatch");
  assert(project.project.orchestrator === snapshot.active_root.plugin, "Specialization delta is not this Project's active root");
  assert(validScope(binding.scope), "Specialization scope must be explicitly bound");
  assert(same(binding.task_ref, taskRef) && snapshot.task_ref.id === taskRef.id, "Specialization Task binding is stale or belongs to another Task");
  assert(binding.organization_ref === project.project.organization_ref && typeof binding.organization_ref === "string" && binding.organization_ref, "Specialization OrganizationRef scope mismatch");
  const generation = project.custom_agents?.materialized_generation;
  assert(Number.isSafeInteger(generation) && project.custom_agents.loaded_generation === generation
    && project.orchestration?.runtime_restart_required === false && binding.materialized_generation === generation
    && binding.loaded_generation === generation, "Specialization runtime generation is not currently loaded");
  assert(binding.snapshot_ref?.kind === "OrchestratorCompositionSnapshot" && binding.snapshot_ref.id === snapshot.id
    && binding.snapshot_ref.digest === snapshot.composed_digest, "Specialization snapshot binding mismatch");
  assert(binding.composition_id === snapshot.composition_id, "Specialization composition identity mismatch");
  for (const name of ["generic_base", "delta", "active_root"]) assert(same(pin(binding[name], name), pin(snapshot[name], name)), "Specialization exact " + name + " pin mismatch");
  assert(same(closure(binding.provider_closure), closure(snapshot.provider_closure)), "Specialization provider closure mismatch");
  for (const expected of [snapshot.generic_base, snapshot.delta, ...snapshot.provider_closure]) {
    const rows = project.provider_resolution?.providers?.filter(provider => provider.name === expected.plugin) ?? [];
    assert(rows.length === 1 && rows[0].version === expected.version && rows[0].selector === expected.selector
      && rows[0].installation === "installed" && rows[0].enablement === "enabled" && rows[0].runtime === "loaded",
    "Specialization exact capability is not currently installed/enabled/loaded: " + expected.plugin);
  }
  const core = pin(binding.core, "Core");
  assert(core.plugin === "woia-core" && core.version === project.core_version, "Specialization Core version is stale");
  assert(snapshot.core && same(core, pin(snapshot.core, "Core")), "Specialization exact Core pin mismatch");
  for (const key of ["organization_profile_revision", "department_profile_revision"]) assert(binding[key] === snapshot[key], "Specialization profile revision mismatch: " + key);
  for (const key of ["policy_revision", "source_map_revision"]) assert(Number.isSafeInteger(binding[key]) && binding[key] >= 1, "Current specialization " + key + " is required");
  requireStrings(requiredSlots, "requiredSlots", {unique: true});
  assert(requiredSlots.every(slot => snapshot.exported_slots.includes(slot)), "Requested specialization slot is not exported by the admitted base");

  const accepted = [];
  const descriptorRefs = [];
  for (const envelope of descriptors) {
    const allowedFields = ["schema", "id", "status", "source_ref", "revision", "digest_sha256", "descriptor", "org_id", "scope", "domain_source_ref"];
    assert(envelope && Object.keys(envelope).every(key => allowedFields.includes(key))
      && (envelope.schema === undefined || envelope.schema === "dev.woia.accepted-domain-descriptor/v1"), "Invalid accepted domain descriptor envelope schema/fields");
    assert(envelope?.status === "ACCEPTED_CURRENT" && sourceRevision(envelope.revision)
      && HEX.test(envelope.digest_sha256) && envelope.source_ref && envelope.descriptor?.schema && (envelope.id || envelope.descriptor.id),
    "Accepted current domain descriptor binding is required");
    const descriptor = envelope.descriptor;
    assert(envelope.id === undefined || descriptor.id === undefined || envelope.id === descriptor.id, "Domain descriptor envelope identity mismatch");
    assert(envelope.digest_sha256 === descriptorDigest(descriptor)
      && (descriptor.revision === undefined || descriptor.revision === envelope.revision)
      && (descriptor.source_ref === undefined || same(descriptor.source_ref, envelope.source_ref)), "Domain descriptor content/revision digest mismatch");
    assert((descriptor.org_id ?? envelope.org_id) === binding.organization_ref && same(descriptor.scope ?? envelope.scope, binding.scope), "Domain descriptor organization/scope mismatch");
    if (descriptor.task_ref !== undefined) assert(same(descriptor.task_ref, taskRef), "Domain descriptor Task scope mismatch");
    const sources = domainSources.filter(source => same(source.source_ref, envelope.source_ref));
    assert(sources.length === 1 && sources[0].current === true && sources[0].revision === envelope.revision
      && sources[0].digest_sha256 === envelope.digest_sha256, "Domain descriptor source is missing, stale or ambiguous");
    const reference = {kind: "DomainDescriptor", id: descriptor.id ?? envelope.id, source_ref: structuredClone(envelope.source_ref), revision: envelope.revision, digest_sha256: envelope.digest_sha256};
    assert(!descriptorRefs.some(ref => ref.id === reference.id), "Duplicate accepted domain descriptor identity");
    descriptorRefs.push(reference);
    accepted.push({...structuredClone(envelope), schema: "dev.woia.accepted-domain-descriptor/v1", id: reference.id});
  }
  requireStrings(requiredDescriptorIds, "requiredDescriptorIds", {unique: true});
  assert(requiredDescriptorIds.every(id => descriptorRefs.some(ref => ref.id === id)), "Required accepted domain descriptor is missing");
  assert(Array.isArray(binding.descriptor_refs) && same([...binding.descriptor_refs].sort((a, b) => a.id.localeCompare(b.id)), [...descriptorRefs].sort((a, b) => a.id.localeCompare(b.id))), "Specialization descriptor binding set mismatch");

  assert(policies && POLICY_ROLES.every(role => policies[role]), "Base, organization, delta and provider policies must all be resolved");
  for (const role of POLICY_ROLES) {
    const policy = policies[role];
    assert(policy.schema === "dev.woia.specialization-policy/v1" && policy.role === role && policy.status === "accepted"
      && policy.organization_ref === binding.organization_ref && same(policy.scope, binding.scope)
      && Number.isSafeInteger(policy.revision) && policy.revision >= 1, "Invalid scoped trusted " + role + " specialization policy");
    const ref = binding.policy_refs?.[role];
    assert(ref?.id === policy.id && ref.revision === policy.revision && ref.digest === "sha256:" + descriptorDigest(policy), "Stale " + role + " specialization policy binding");
    requireStrings(policy.permitted_actions, role + ".permitted_actions", {unique: true});
    requireStrings(policy.permitted_outcomes, role + ".permitted_outcomes", {unique: true});
    assert(!policy.denials?.length, "Specialization policy denial must be reconciled");
  }
  assert(binding.policy_revision === policies.organization.revision, "Organization policy revision mismatch");
  return {
    schema: "dev.woia.specialization-context/v1", composition_id: snapshot.composition_id, status: "qualified", current: true,
    department: binding.department, project_ref: binding.project_ref, task_ref: structuredClone(taskRef), organization_ref: binding.organization_ref,
    scope: structuredClone(binding.scope), snapshot_ref: structuredClone(binding.snapshot_ref), binding_ref: {kind: "SpecializationBinding", id: binding.id, revision: binding.revision},
    binding_revision: binding.revision, materialized_generation: generation, loaded_generation: generation,
    generic_base: structuredClone(snapshot.generic_base), delta: structuredClone(snapshot.delta), active_root: structuredClone(snapshot.active_root), core,
    provider_closure: structuredClone(snapshot.provider_closure), exported_slots: [...snapshot.exported_slots], required_gates: [...snapshot.required_gates],
    organization_profile_revision: binding.organization_profile_revision, department_profile_revision: binding.department_profile_revision,
    policy_revision: binding.policy_revision, source_map_revision: binding.source_map_revision,
    domain_refs: descriptorRefs, descriptors: accepted,
    permitted_actions: intersect(POLICY_ROLES.map(role => policies[role].permitted_actions)),
    permitted_outcomes: intersect(POLICY_ROLES.map(role => policies[role].permitted_outcomes)),
  };
}

async function durableRecord(root, directory, reference, expectedSchema = null) {
  assert(reference && typeof reference.id === "string" && reference.id, "Durable specialization reference is required");
  let entries;
  try {entries = await readdir(path.join(root, ".woia", directory), {withFileTypes: true});} catch (error) {if (error.code === "ENOENT") entries = []; else throw error;}
  const matches = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), "Specialization state contains a symlink/reparse entry");
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(path.join(root, ".woia", directory, entry.name), "utf8"));
    if (value.id === reference.id && (!expectedSchema || value.schema === expectedSchema)) matches.push(value);
  }
  assert(matches.length === 1, "Durable specialization record is missing or ambiguous: " + reference.id);
  const value = matches[0];
  if (reference.revision !== undefined) assert(value.revision === reference.revision, "Durable specialization record revision is stale: " + reference.id);
  return value;
}

/** Reads fixed Project-owned collections. It accepts no request-supplied module or record path. */
export async function loadSpecializationContext({root, taskRef, bindingRef, requiredSlots = [], requiredDescriptorIds = []}) {
  root = path.resolve(root);
  const project = JSON.parse(await readFile(path.join(root, ".woia", "project.json"), "utf8"));
  const task = await durableRecord(root, "tasks", taskRef, "dev.woia.task/v1");
  assert(taskRef.kind === "Task" && task.department === project.project.department
    && ["ready", "active", "waiting"].includes(task.state) && !task.blockers?.length, "Task is not eligible for specialization resolution");
  const binding = await durableRecord(root, "specialization-bindings", bindingRef, "dev.woia.specialization-binding/v1");
  const snapshot = await durableRecord(root, "snapshots", binding.snapshot_ref, "dev.woia.orchestrator-composition-snapshot/v1");
  const descriptors = [];
  const domainSources = [];
  for (const ref of binding.descriptor_refs ?? []) {
    const envelope = await durableRecord(root, "domain-descriptors", ref);
    descriptors.push(envelope);
    domainSources.push(await durableRecord(root, "domain-sources", envelope.domain_source_ref));
  }
  const policies = {};
  for (const role of POLICY_ROLES) policies[role] = await durableRecord(root, "specialization-policies", binding.policy_refs?.[role], "dev.woia.specialization-policy/v1");
  return createSpecializationContext({snapshot, project, taskRef, binding, descriptors, domainSources, policies, requiredSlots, requiredDescriptorIds});
}
