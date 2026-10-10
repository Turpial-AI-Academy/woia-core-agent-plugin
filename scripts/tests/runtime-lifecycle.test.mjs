import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {bootstrapProject} from "../../skills/project-runtime/scripts/bootstrap-project.mjs";
import {previewCapabilityUpdate, applyInstallationBindingUpdate} from "../../skills/project-runtime/scripts/capability-update.mjs";
import {createOrchestratorCompositionSnapshot} from "../../skills/project-improvement/scripts/create-orchestrator-composition-snapshot.mjs";
import {createCapabilitySnapshot} from "../../skills/project-improvement/scripts/create-capability-snapshot.mjs";
import {createSpecializationContext, descriptorDigest, loadSpecializationContext} from "../../skills/project-runtime/scripts/specialization-context.mjs";
import {requireLocalWrite} from "../../skills/project-runtime/scripts/authority-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORE = JSON.parse(await readFile(path.join(ROOT, "plugin.json"), "utf8")).version;
const taskRef = {kind: "Task", id: "task-contract", revision: 1};
const now = "2026-10-10T12:00:00Z";
const hash = value => createHash("sha256").update(value).digest("hex");
const exact = (plugin, version) => ({plugin, version, selector: "v" + version});
const json = file => readFile(file, "utf8").then(JSON.parse);
async function save(file, value) {await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, JSON.stringify(value, null, 2) + "\n");}

async function sandbox(t) {
  const parent = path.resolve(process.env.WOIA_TEST_TMP ?? os.tmpdir());
  await mkdir(parent, {recursive: true});
  const root = await mkdtemp(path.join(parent, "woia-core-contract-"));
  t.after(async () => {assert.equal(path.dirname(root), parent); await rm(root, {recursive: true, force: true});});
  await bootstrapProject({root, projectId: "project-contract", department: "services", orchestrator: "woia-service", organizationRef: "org-contract"});
  return root;
}

function project() {
  return {
    schema: "dev.woia.core-project-state/v1", core_version: CORE,
    project: {id: "project-contract", department: "services", orchestrator: "woia-service", organization_ref: "org-contract"},
    root_agent_binding: {status: "bound", instructions_file: "AGENTS.md", managed_block_id: "WOIA_PROJECT_OPERATING_CONTRACT"},
    custom_agents: {materialized_generation: 3, loaded_generation: 3, status: "loaded", roles: []},
    provider_resolution: {installation_policy: "ask_once", status: "runtime_ready", providers: [{name: "woia-service", version: "0.5.8", selector: "v0.5.8", responsibility: "Coordinate service", publication: "available", discoverability: "discoverable", installation: "installed", enablement: "enabled", runtime: "loaded"}], install_plan: []},
    orchestration: {status: "runtime_ready", runtime_restart_required: false, current_run_id: "run-old"},
    storage: {tasks: ".woia/tasks", receipts: ".woia/receipts", overlays: ".woia/overlays", snapshots: ".woia/snapshots", effects: ".woia/effects", checkpoints: ".woia/checkpoints"}, updated_at: now,
  };
}

function installation(root = path.resolve("fixture-destination")) {
  return {schema: "dev.woia.installation-binding/v1", installation_id: "1".repeat(32), lock_sha256: "2".repeat(64), index_sha256: "3".repeat(64), root,
    project_id: "project-contract", department: "services", generation: 4, loaded_generation: null, host_verified: false, revision: 1, roles: [],
    plugins: [{id: "woia-core", version: CORE, tag: "v" + CORE}, {id: "woia-service", version: "0.5.8", tag: "v0.5.8"}]};
}

function specializationFixture() {
  const providers = [exact("woia-service-provider", "0.5.8")];
  // Synthetic declarations exercise contracts only; they are not release qualification evidence.
  const declaration = {schema: "dev.woia.orchestrator-specialization/v1", id: "service-specialization", department: "services", status: "qualified",
    generic_base: {plugin: "woia-service", version_range: {min_inclusive: "0.5.8", max_exclusive: "0.6.0"}}, delta: {plugin: "woia-service-delta"},
    allowed_operations: ["SPECIALIZE", "NARROW"], exported_slots: ["service-policy"], required_gates: ["authority-narrowing", "provider-closure"],
    evaluated_pairs: [{base_version: "0.5.8", delta_version: "0.1.0", core_version: CORE, status: "passed", provider_closure: providers.map(({plugin, version}) => ({plugin, version})), evidence: ["synthetic-contract-test-only"]}]};
  const snapshot = createOrchestratorCompositionSnapshot({declaration, taskRef, projectRef: "project-contract", department: "services", baseVersion: "0.5.8", baseSelector: "v0.5.8", deltaVersion: "0.1.0", deltaSelector: "v0.1.0", coreVersion: CORE, coreSelector: "v" + CORE, providers, organizationRevision: 1, departmentRevision: 1, createdAt: now});
  const descriptor = {schema: "dev.fixture.service-descriptor/v1", id: "service.contract", source_ref: "source:service-contract", revision: "revision-1", org_id: "org-contract", scope: "services.policy", permitted_actions: ["service.prepare"]};
  const envelope = {schema: "dev.woia.accepted-domain-descriptor/v1", id: descriptor.id, status: "ACCEPTED_CURRENT", source_ref: descriptor.source_ref, revision: descriptor.revision, digest_sha256: descriptorDigest(descriptor), descriptor, domain_source_ref: {id: "source-current", revision: descriptor.revision}};
  const domainSource = {id: "source-current", current: true, source_ref: envelope.source_ref, revision: envelope.revision, digest_sha256: envelope.digest_sha256};
  const policies = {};
  const policyRefs = {};
  for (const role of ["base", "organization", "delta", "provider"]) {
    const policy = {schema: "dev.woia.specialization-policy/v1", id: "policy-" + role, revision: 1, role, status: "accepted", organization_ref: "org-contract", scope: "services.policy",
      permitted_actions: role === "delta" ? ["service.prepare"] : ["service.prepare", "service.send"], permitted_outcomes: ["remote-observation"]};
    policies[role] = policy;
    policyRefs[role] = {kind: "SpecializationPolicy", id: policy.id, revision: policy.revision, digest: "sha256:" + descriptorDigest(policy)};
  }
  const binding = {schema: "dev.woia.specialization-binding/v1", id: "specialization-binding", revision: 1, status: "active", composition_id: snapshot.composition_id,
    project_ref: "project-contract", task_ref: taskRef, department: "services", organization_ref: "org-contract", scope: "services.policy",
    snapshot_ref: {kind: "OrchestratorCompositionSnapshot", id: snapshot.id, digest: snapshot.composed_digest},
    generic_base: snapshot.generic_base, delta: snapshot.delta, active_root: snapshot.active_root, core: snapshot.core, provider_closure: providers,
    materialized_generation: 3, loaded_generation: 3, organization_profile_revision: 1, department_profile_revision: 1, policy_revision: 1, source_map_revision: 1,
    policy_refs: policyRefs, descriptor_refs: [{kind: "DomainDescriptor", id: descriptor.id, source_ref: envelope.source_ref, revision: envelope.revision, digest_sha256: envelope.digest_sha256}]};
  const current = project();
  current.project.orchestrator = snapshot.active_root.plugin;
  current.provider_resolution.providers = [snapshot.generic_base, snapshot.delta, ...snapshot.provider_closure].map(pin => ({name: pin.plugin, version: pin.version, selector: pin.selector, responsibility: pin.plugin, publication: "available", discoverability: "discoverable", installation: "installed", enablement: "enabled", runtime: "loaded"}));
  return {declaration, project: current, snapshot, taskRef, binding, descriptors: [envelope], domainSources: [domainSource], policies, requiredSlots: ["service-policy"], requiredDescriptorIds: [descriptor.id]};
}

test("trusted specialization narrows base, organization, delta and provider policies", () => {
  const input = specializationFixture();
  const output = createSpecializationContext(input);
  assert.deepEqual(output.permitted_actions, ["service.prepare"]);
  assert.deepEqual(output.permitted_outcomes, ["remote-observation"]);
  assert.equal(output.active_root.plugin, "woia-service-delta");
  assert.equal(output.domain_refs[0].revision, "revision-1");
  assert.equal(output.loaded_generation, 3);
});

test("capability snapshots require immutable selectors", async t => {
  const root = await sandbox(t);
  const args = {taskId: taskRef.id, capability: "service.prepare", plugin: "woia-service", version: "0.5.8", selector: "main", overlays: [], output: path.join(root, ".woia/snapshots/immutable.json")};
  await assert.rejects(createCapabilitySnapshot(args), /exact version tag or immutable commit/);
});

test("concurrent capability snapshot writers cannot replace the winning exact pin", async t => {
  const root = await sandbox(t), output = path.join(root, ".woia/snapshots/immutable.json");
  const args = {taskId: taskRef.id, capability: "service.prepare", plugin: "woia-service", version: "0.5.8", selector: "v0.5.8", overlays: [], output};
  const results = await Promise.allSettled([createCapabilitySnapshot(args), createCapabilitySnapshot({...args, version: "0.5.7", selector: "v0.5.7"})]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.message, "snapshots are immutable");
  const winning = results.find(result => result.status === "fulfilled").value.snapshot;
  assert.deepEqual(await json(output), winning);
});

test("an exact Core evaluation is mandatory for new specialization context", () => {
  const input = specializationFixture();
  input.binding.core = exact("woia-core", "0.5.0");
  assert.throws(() => createSpecializationContext(input), /Core version is stale/);
  delete input.snapshot.core;
  assert.throws(() => createSpecializationContext(input), /snapshot content digest/);
});

test("exact Core constructor pin must match the evaluated tuple", () => {
  const input = specializationFixture();
  assert.throws(() => createOrchestratorCompositionSnapshot({declaration: input.declaration, taskRef, projectRef: "project-contract", department: "services", baseVersion: "0.5.8", baseSelector: "v0.5.8", deltaVersion: "0.1.0", deltaSelector: "v0.1.0", coreVersion: "0.5.0", coreSelector: "v0.5.0", providers: input.snapshot.provider_closure, createdAt: now}), /Core version/);
});

test("snapshot tampering and an unexported slot fail closed", () => {
  const input = specializationFixture();
  input.snapshot.exported_slots.push("unqualified-slot");
  assert.throws(() => createSpecializationContext(input), /content digest/);
  const second = specializationFixture();
  second.requiredSlots = ["unqualified-slot"];
  assert.throws(() => createSpecializationContext(second), /not exported/);
});

test("delta, provider closure, current Task and loaded generation cannot be substituted", () => {
  for (const mutate of [
    input => {input.binding.delta = exact("different-delta", "0.1.0");},
    input => {input.binding.provider_closure = [];},
    input => {input.binding.task_ref = {...taskRef, revision: 2};},
    input => {input.project.custom_agents.loaded_generation = null;},
    input => {input.project.project.orchestrator = "woia-service";},
    input => {input.project.provider_resolution.providers = input.project.provider_resolution.providers.filter(provider => provider.name !== "woia-service-delta");},
    input => {input.project.provider_resolution.providers[0].runtime = "not_loaded";},
  ]) {
    const input = specializationFixture();
    mutate(input);
    assert.throws(() => createSpecializationContext(input));
  }
});

test("domain descriptor contents, acceptance, source and organization are independently checked", () => {
  for (const mutate of [
    input => {input.descriptors[0].descriptor.permitted_actions.push("service.send");},
    input => {input.descriptors[0].status = "STALE";},
    input => {input.domainSources[0].current = false;},
    input => {input.domainSources[0].revision = "revision-2";},
    input => {input.binding.organization_ref = "different-org";},
    input => {input.descriptors = [];},
    input => {input.descriptors[0].schema = "dev.invalid.accepted-envelope/v1";},
  ]) {
    const input = specializationFixture();
    mutate(input);
    assert.throws(() => createSpecializationContext(input));
  }
});

test("absent policy, stale revision and policy denial never grant fallback authority", () => {
  for (const mutate of [
    input => {delete input.policies.organization;},
    input => {input.policies.provider.revision++;},
    input => {input.policies.base.denials = ["no-sending"];},
  ]) {
    const input = specializationFixture();
    mutate(input);
    assert.throws(() => createSpecializationContext(input));
  }
});

test("fixed Project collections resolve context without request module paths", async t => {
  const root = await sandbox(t), input = specializationFixture();
  await save(path.join(root, ".woia/project.json"), input.project);
  await save(path.join(root, ".woia/tasks/task.json"), {schema: "dev.woia.task/v1", id: taskRef.id, revision: 1, department: "services", state: "active", blockers: []});
  await save(path.join(root, ".woia/specialization-bindings/binding.json"), input.binding);
  await save(path.join(root, ".woia/snapshots/snapshot.json"), input.snapshot);
  await save(path.join(root, ".woia/domain-descriptors/descriptor.json"), input.descriptors[0]);
  await save(path.join(root, ".woia/domain-sources/source.json"), input.domainSources[0]);
  for (const policy of Object.values(input.policies)) await save(path.join(root, ".woia/specialization-policies", policy.id + ".json"), policy);
  const result = await loadSpecializationContext({root, taskRef, bindingRef: {kind: "SpecializationBinding", id: input.binding.id, revision: 1}, requiredSlots: input.requiredSlots, requiredDescriptorIds: input.requiredDescriptorIds});
  assert.deepEqual(result.permitted_actions, ["service.prepare"]);
  await assert.rejects(loadSpecializationContext({root, taskRef, bindingRef: {id: "missing", revision: 1}}), /missing or ambiguous/);
});

test("transition clears load marks and projects the selected installed providers", () => {
  const result = previewCapabilityUpdate({project: project(), installationBinding: installation(), now});
  assert.equal(result.generation, 4);
  assert.equal(result.state.custom_agents.loaded_generation, null);
  assert.equal(result.state.provider_resolution.providers[0].runtime, "not_loaded");
  assert.equal(result.state.provider_resolution.authorized_plan_id, "installation-lock:" + "2".repeat(64));
  assert.equal(result.state.orchestration.current_run_id, null);
});

test("UNKNOWN, attempted and not-attempted effects block updates", () => {
  for (const state of ["unknown", "UNKNOWN", "attempted", "partial", "not-attempted", "pending"]) assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: installation(), effects: [{id: "effect", state}]}), /Reconcile pending or UNKNOWN/);
});

test("a running native run must checkpoint or finish before updating", () => {
  assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: installation(), runs: [{id: "running", state: "running"}]}), /in-flight native runs/);
});

test("changed in-flight pins and incompatible overlays require reconciliation", () => {
  const snapshot = {schema: "dev.woia.effective-capability-snapshot/v1", id: "snapshot-old", task_ref: taskRef, base: exact("woia-service", "0.5.7")};
  assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: installation(), tasks: [{id: taskRef.id, state: "active", capability_snapshot_refs: [{kind: "Snapshot", id: snapshot.id}]}], snapshots: [snapshot]}), /pins unavailable capability/);
  const overlay = {schema: "dev.woia.plugin-overlay/v1", id: "overlay", plugin: "woia-service", compatibility: {status: "compatible", last_validated_base: "0.5.7", conflicts: []}};
  assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: installation(), overlays: [overlay]}), /incompatible overlay/);
});

test("an explicit selected root may change only when no in-flight Task depends on the old root", () => {
  const binding = installation();
  binding.plugins.push({id: "woia-service-delta", version: "0.1.0", tag: "v0.1.0"});
  binding.orchestrator = "woia-service-delta";
  assert.equal(previewCapabilityUpdate({project: project(), installationBinding: binding}).state.project.orchestrator, "woia-service-delta");
  assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: binding, tasks: [{id: taskRef.id, state: "active"}]}), /changing the active root/);
  binding.orchestrator = "uninstalled-root";
  assert.throws(() => previewCapabilityUpdate({project: project(), installationBinding: binding}), /not in the installed plugin set/);
});

test("externally owned roles are preserved or cause a conflict", () => {
  const state = project();
  state.custom_agents.roles = ["external_role"];
  assert.throws(() => previewCapabilityUpdate({project: state, installationBinding: installation()}), /externally owned roles/);
  const binding = installation();
  binding.roles = ["external_role", "woia_service"];
  assert.deepEqual(previewCapabilityUpdate({project: state, installationBinding: binding}).state.custom_agents.roles, binding.roles);
});

test("prior managed roles require an exact verified migration receipt", () => {
  const state = project(), binding = installation();
  state.custom_agents.roles = ["old_managed_role"];
  binding.previous_managed_roles = ["old_managed_role"];
  const bytes = JSON.stringify(state, null, 2) + "\n", projectSha256 = hash(bytes);
  const receipt = {schema: "dev.woia.installation-migration/v1", proof_status: "VERIFIED", prior_project_sha256: projectSha256, candidate_lock_sha256: binding.lock_sha256,
    previous_managed_roles: [{name: "old_managed_role", path: ".codex/agents/old.toml", sha256: "4".repeat(64), binding_digest: "5".repeat(64), generation: 3}]};
  const receiptSha = hash(JSON.stringify(receipt));
  binding.migration_receipt_sha256 = receiptSha;
  const args = {project: state, installationBinding: binding, migrationReceipt: receipt, migrationReceiptSha256: receiptSha, projectSha256};
  assert.deepEqual(previewCapabilityUpdate(args).state.custom_agents.roles, []);
  assert.throws(() => previewCapabilityUpdate({...args, migrationReceiptSha256: "6".repeat(64)}), /Verified exact migration receipt/);
  assert.throws(() => previewCapabilityUpdate({...args, migrationReceipt: {...receipt, proof_status: "PENDING"}}), /Verified exact migration receipt/);
});

test("durable transition preserves exact Task snapshot and retires old harness bindings", async t => {
  const root = await sandbox(t), state = project();
  await save(path.join(root, ".woia/project.json"), state);
  const snapshot = {schema: "dev.woia.effective-capability-snapshot/v1", id: "snapshot-current", task_ref: taskRef, base: exact("woia-service", "0.5.8")};
  await save(path.join(root, ".woia/snapshots/current.json"), snapshot);
  await save(path.join(root, ".woia/tasks/task.json"), {id: taskRef.id, state: "active", capability_snapshot_refs: [{kind: "Snapshot", id: snapshot.id}]});
  await save(path.join(root, ".woia/bindings/binding.json"), {id: "runtime-binding", revision: 1, state: "active", loaded_generation: 3});
  await save(path.join(root, ".woia/agents/agent.json"), {id: "agent", revision: 1, active_binding_ref: {kind: "HarnessRuntimeBinding", id: "runtime-binding"}});
  await save(path.join(root, ".woia/runtime/sessions/session.json"), {id: "session", state: "active", loaded_generation: 3});
  await save(path.join(root, ".woia/runtime/current-session.json"), {id: "session", state: "active", loaded_generation: 3});
  const snapshotBytes = await readFile(path.join(root, ".woia/snapshots/current.json"), "utf8");
  const projectBytes = await readFile(path.join(root, ".woia/project.json"), "utf8");
  const result = await applyInstallationBindingUpdate({root, expectedGeneration: 3, expectedProjectSha256: hash(projectBytes), installationBinding: installation(root)});
  assert.equal(result.action, "INSTALLATION_BINDING_UPDATED");
  assert.equal((await json(path.join(root, ".woia/project.json"))).custom_agents.loaded_generation, null);
  assert.equal((await json(path.join(root, ".woia/bindings/binding.json"))).state, "stale");
  assert.equal((await json(path.join(root, ".woia/agents/agent.json"))).active_binding_ref, null);
  assert.equal((await json(path.join(root, ".woia/runtime/current-session.json"))).state, "closed");
  assert.equal(await readFile(path.join(root, ".woia/snapshots/current.json"), "utf8"), snapshotBytes);
  await assert.rejects(applyInstallationBindingUpdate({root, expectedGeneration: 3, expectedProjectSha256: hash(projectBytes), installationBinding: installation(root)}), /CAS conflict/);
});

test("preflight failure does not change Project bytes or generations", async t => {
  const root = await sandbox(t);
  await save(path.join(root, ".woia/project.json"), project());
  await save(path.join(root, ".woia/effects/unknown.json"), {id: "unknown-effect", state: "unknown"});
  const file = path.join(root, ".woia/project.json"), bytes = await readFile(file, "utf8");
  await assert.rejects(applyInstallationBindingUpdate({root, expectedGeneration: 3, expectedProjectSha256: hash(bytes), installationBinding: installation(root)}), /UNKNOWN/);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("concurrent transitions have one winner under the shared lifecycle fence", async t => {
  const root = await sandbox(t);
  await save(path.join(root, ".woia/project.json"), project());
  const bytes = await readFile(path.join(root, ".woia/project.json"), "utf8");
  const args = {root, expectedGeneration: 3, expectedProjectSha256: hash(bytes), installationBinding: installation(root)};
  const results = await Promise.allSettled([applyInstallationBindingUpdate(args), applyInstallationBindingUpdate(args)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await json(path.join(root, ".woia/project.json"))).custom_agents.materialized_generation, 4);
});

test("same-version bootstrap cannot restore stale load marks over an update", async t => {
  const root = await sandbox(t);
  for (let iteration = 0; iteration < 8; iteration++) {
    await save(path.join(root, ".woia/project.json"), project());
    const bytes = await readFile(path.join(root, ".woia/project.json"), "utf8");
    const results = await Promise.allSettled([
      bootstrapProject({root, projectId: "project-contract", department: "services", orchestrator: "woia-service", organizationRef: "org-contract"}),
      applyInstallationBindingUpdate({root, expectedGeneration: 3, expectedProjectSha256: hash(bytes), installationBinding: installation(root)}),
    ]);
    if (results[1].status === "fulfilled") {
      const state = await json(path.join(root, ".woia/project.json"));
      assert.equal(state.custom_agents.materialized_generation, 4);
      assert.equal(state.custom_agents.loaded_generation, null);
    }
  }
});

test("Core patch bootstrap invalidates loaded generation and retains nullable OrganizationRef", async t => {
  const root = await sandbox(t), file = path.join(root, ".woia/project.json");
  const state = await json(file);
  state.core_version = "0.5.0";
  state.project.organization_ref = null;
  state.custom_agents.materialized_generation = 3;
  state.custom_agents.loaded_generation = 3;
  await save(file, state);
  const result = await bootstrapProject({root, projectId: "project-contract", department: "services", orchestrator: "woia-service", organizationRef: null});
  assert.equal(result.state.core_version, CORE);
  assert.equal(result.state.project.organization_ref, null);
  assert.equal(result.state.custom_agents.materialized_generation, 4);
  assert.equal(result.state.custom_agents.loaded_generation, null);
  assert.deepEqual(await json(file), result.state);
});

test("local-write authority requires the current loaded runtime binding and root session", async t => {
  const root = await sandbox(t);
  await save(path.join(root, ".woia/project.json"), project());
  const agentRef = {kind: "AgentInstance", id: "agent-guard", revision: 1};
  const request = {projectId: "project-contract", department: "services", principalId: agentRef.id, taskRef, agentRef, capability: "service.report", operation: "write", effectClass: "local-write", target: "report.md", resourceRef: {type: "Report", id: "report", uri: "report.md"}};
  await save(path.join(root, ".woia/tasks/task.json"), {schema: "dev.woia.task/v1", id: taskRef.id, revision: taskRef.revision, department: "services", state: "active", blockers: [], expected_outputs: ["report.md"]});
  await save(path.join(root, ".woia/agents/agent.json"), {schema: "dev.woia.agent-instance/v1", id: agentRef.id, revision: 1, lifecycle: "active", task_ref: taskRef,
    authority_context_ref: {kind: "AuthorityContext", id: "authority", revision: 1}, active_binding_ref: {kind: "HarnessRuntimeBinding", id: "binding-guard"}, resource_scope: [request.resourceRef]});
  await save(path.join(root, ".woia/bindings/binding.json"), {schema: "dev.woia.runtime-binding/v1", id: "binding-guard", revision: 1, state: "active", task_ref: {kind: "Task", id: taskRef.id}, agent_instance_ref: {kind: "AgentInstance", id: agentRef.id}, materialized_generation: 3, loaded_generation: 3, root_session_id: "session-guard"});
  await save(path.join(root, ".woia/runtime/current-session.json"), {id: "session-guard", state: "active", loaded_generation: 3});
  await save(path.join(root, ".woia/authority-contexts/authority.json"), {schema: "dev.woia.authority-context/v1", id: "authority", revision: 1, principal: {kind: "agent-instance", id: agentRef.id}, department: "services", task_ref: taskRef,
    denials: [], grants: [{capability: "service.report", operations: ["write"], effect_classes: ["local-write"]}]});
  assert.equal((await requireLocalWrite(root, request)).allowed, true);
  const changed = project();
  changed.custom_agents.loaded_generation = null;
  await save(path.join(root, ".woia/project.json"), changed);
  await assert.rejects(requireLocalWrite(root, request), /runtime generation is not loaded/);
  await save(path.join(root, ".woia/project.json"), project());
  await save(path.join(root, ".woia/runtime/current-session.json"), {id: "old-session", state: "active", loaded_generation: 3});
  await assert.rejects(requireLocalWrite(root, request), /current root-session observation/);
  await assert.rejects(readFile(path.join(root, "report.md")), {code: "ENOENT"});
});

test("new typed outputs validate against the installed Core schema graph", async () => {
  const ajv = new Ajv2020({strict: false, allErrors: true, formats: {"date-time": true}});
  const {readdir} = await import("node:fs/promises");
  for (const name of (await readdir(path.join(ROOT, "dev.woia/schemas"))).filter(name => name.endsWith(".schema.json"))) ajv.addSchema(await json(path.join(ROOT, "dev.woia/schemas", name)));
  const input = specializationFixture();
  for (const [name, value] of [["specialization-binding", input.binding], ["specialization-context", createSpecializationContext(input)], ["project-state", previewCapabilityUpdate({project: project(), installationBinding: installation(), now}).state]]) {
    const validate = ajv.getSchema("https://woia.dev/schemas/core/v0.5.0/" + name + ".schema.json");
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
});
