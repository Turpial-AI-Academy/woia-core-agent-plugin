import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {withRuntimeLifecycleLock} from "./agent-thread-lifecycle.mjs";
import {requireSelector} from "./b4-contract.mjs";
import {validateCompositionSnapshot} from "./specialization-context.mjs";

const CORE_VERSION = /^0\.5\.(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL_TASKS = new Set(["completed", "failed", "cancelled", "superseded"]);
const TERMINAL_EFFECTS = new Set(["confirmed", "rejected", "compensated"]);
const assert = (condition, message) => {if (!condition) throw new Error(message);};
const hash = value => createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function pinKey(pin) {return (pin.plugin ?? pin.id) + "@" + pin.version;}
function sameNames(left, right) {return Array.isArray(right) && right.every(name => typeof name === "string" && name) && new Set(right).size === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());}
function snapshotPins(snapshot) {
  if (snapshot.schema === "dev.woia.effective-capability-snapshot/v1") return [snapshot.base];
  if (snapshot.schema === "dev.woia.orchestrator-composition-snapshot/v1") {
    return [snapshot.generic_base, snapshot.delta, ...(snapshot.core ? [snapshot.core] : []), ...(snapshot.provider_closure ?? [])];
  }
  throw new Error("Unsupported pinned Task snapshot: " + snapshot.id);
}

function installationReference(binding) {
  assert(binding.schema === "dev.woia.installation-binding/v1", "Unsupported installation binding");
  assert(/^[0-9a-f]{32}$/.test(binding.installation_id), "Invalid installation identity");
  assert(HEX64.test(binding.lock_sha256) && HEX64.test(binding.index_sha256), "Installation binding requires exact lock/index hashes");
  assert(Number.isSafeInteger(binding.revision) && binding.revision >= 1, "Invalid installation binding revision");
  assert(binding.loaded_generation === null && binding.host_verified === false, "An installation transition must invalidate host-load observations");
  assert(Array.isArray(binding.plugins) && binding.plugins.length, "Installation binding requires a resolved plugin set");
  const ids = binding.plugins.map(item => item.id);
  assert(new Set(ids).size === ids.length && ids.every(id => typeof id === "string" && id), "Installation binding contains duplicate or missing plugin identities");
  assert(binding.plugins.every(item => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version)), "Installation binding contains invalid plugin versions");
  if (binding.roles !== undefined) assert(Array.isArray(binding.roles) && binding.roles.every(role => typeof role === "string" && role)
    && new Set(binding.roles).size === binding.roles.length, "Installation roles must be unique nonempty names");
  return {installation_id: binding.installation_id, revision: binding.revision, digest: "sha256:" + hash(canonical(binding)), lock_sha256: binding.lock_sha256, index_sha256: binding.index_sha256, ...(binding.roles ? {roles: [...binding.roles]} : {})};
}

/** Pure preflight. Exact Task pins and overlays are preserved, or the update is blocked. */
export function previewCapabilityUpdate({project, installationBinding = null, nextCoreVersion = project?.core_version, tasks = [], snapshots = [], overlays = [], effects = [], runs = [], migrationReceipt = null, migrationReceiptSha256 = null, projectSha256 = null, now = new Date().toISOString()}) {
  assert(project?.schema === "dev.woia.core-project-state/v1", "Unsupported Core Project state");
  assert(CORE_VERSION.test(nextCoreVersion), "Core update must remain within compatible 0.5.x Project state");
  const generation = project.custom_agents?.materialized_generation;
  assert(Number.isSafeInteger(generation) && generation >= 0 && generation < Number.MAX_SAFE_INTEGER, "Invalid materialized generation");
  const reference = installationBinding ? installationReference(installationBinding) : null;
  if (installationBinding) {
    assert(installationBinding.project_id === project.project.id && installationBinding.department === project.project.department, "Installation binding Project/department mismatch");
    assert(installationBinding.generation === generation + 1, "Installation binding must target the next materialized generation");
    if (installationBinding.orchestrator !== undefined) {
      assert(typeof installationBinding.orchestrator === "string" && installationBinding.plugins.some(plugin => plugin.id === installationBinding.orchestrator), "Selected root orchestrator is not in the installed plugin set");
      if (installationBinding.orchestrator !== project.project.orchestrator) assert(!tasks.some(task => !TERMINAL_TASKS.has(task.state) && task.state !== "draft"), "Reconcile in-flight Tasks before changing the active root orchestrator");
    }
    if (project.installation_binding_ref) {
      assert(reference.installation_id === project.installation_binding_ref.installation_id, "Installation identity cannot change inside one Project");
      assert(reference.revision > project.installation_binding_ref.revision, "Installation binding revision must advance");
    }
  }
  if (!installationBinding && nextCoreVersion === project.core_version) return {action: "UNCHANGED", state: structuredClone(project), previous_generation: generation, generation};

  for (const effect of effects) {
    assert(TERMINAL_EFFECTS.has(String(effect.state).toLowerCase()), "Reconcile pending or UNKNOWN effect before capability update: " + effect.id);
  }
  assert(!runs.some(run => run.state === "running"), "Checkpoint or finish in-flight native runs before capability update");
  const available = new Map((installationBinding?.plugins ?? project.provider_resolution?.providers ?? []).filter(item => item.version).map(item => [item.id ?? item.name ?? item.plugin, {version: item.version, selectors: [item.tag ?? item.selector ?? "v" + item.version, ...(item.commit ? [item.commit] : [])]}]));
  if (!available.has("woia-core")) available.set("woia-core", {version: nextCoreVersion, selectors: ["v" + nextCoreVersion]});
  assert(available.get("woia-core").version === nextCoreVersion, "Installed Core pin does not match requested Core version");
  const bySnapshotId = new Map();
  for (const snapshot of snapshots) {
    assert(!bySnapshotId.has(snapshot.id), "Duplicate durable snapshot identity: " + snapshot.id);
    bySnapshotId.set(snapshot.id, snapshot);
  }
  for (const task of tasks.filter(item => !TERMINAL_TASKS.has(item.state))) {
    const refs = task.capability_snapshot_refs ?? [];
    assert(task.state === "draft" || refs.length, "In-flight Task has no immutable capability pins: " + task.id);
    for (const ref of refs) {
      const snapshot = bySnapshotId.get(ref.id);
      assert(snapshot?.task_ref?.id === task.id, "Missing or conflicting in-flight Task snapshot: " + ref.id);
      if (ref.digest) assert(ref.digest === snapshot.composed_digest, "In-flight Task snapshot digest mismatch: " + ref.id);
      if (snapshot.schema === "dev.woia.orchestrator-composition-snapshot/v1") validateCompositionSnapshot(snapshot);
      for (const pin of snapshotPins(snapshot)) {
        requireSelector(pin.selector, pin.version);
        const target = available.get(pin.plugin);
        assert(target?.version === pin.version && target.selectors.includes(pin.selector), "In-flight Task pins unavailable capability " + pinKey(pin) + "; finish or explicitly reconcile the Task before updating");
      }
    }
  }
  for (const overlay of overlays) {
    assert(overlay.schema === "dev.woia.plugin-overlay/v1" && overlay.compatibility?.status === "compatible"
      && !overlay.compatibility.conflicts?.length && overlay.compatibility.last_validated_base === available.get(overlay.plugin)?.version,
    "Preserve and reconcile incompatible overlay before capability update: " + overlay.id);
  }
  const state = structuredClone(project);
  state.core_version = nextCoreVersion;
  if (installationBinding?.orchestrator !== undefined) state.project.orchestrator = installationBinding.orchestrator;
  state.custom_agents.materialized_generation = generation + 1;
  state.custom_agents.loaded_generation = null;
  state.custom_agents.status = "materialized_pending_reload";
  state.provider_resolution.status = "runtime_restart_required";
  for (const provider of state.provider_resolution.providers) provider.runtime = "not_loaded";
  if (installationBinding) {
    const priorProviders = new Map(project.provider_resolution.providers.map(provider => [provider.name, provider]));
    state.provider_resolution.providers = installationBinding.plugins.filter(plugin => plugin.id !== "woia-core").map(plugin => ({
      name: plugin.id, responsibility: plugin.responsibility ?? priorProviders.get(plugin.id)?.responsibility ?? plugin.id,
      version: plugin.version, selector: plugin.tag ?? "v" + plugin.version,
      publication: "available", discoverability: "discoverable", installation: "installed", enablement: "enabled", runtime: "not_loaded",
    }));
    state.provider_resolution.install_plan = [];
    state.provider_resolution.installation_authorization = "granted";
    state.provider_resolution.install_plan_id = "installation-lock:" + installationBinding.lock_sha256;
    state.provider_resolution.authorized_plan_id = state.provider_resolution.install_plan_id;
    if (installationBinding.roles) {
      const managed = [...(project.installation_binding_ref?.roles ?? [])];
      if (installationBinding.previous_managed_roles !== undefined) {
        assert(migrationReceipt?.schema === "dev.woia.installation-migration/v1" && migrationReceipt.proof_status === "VERIFIED"
          && HEX64.test(migrationReceiptSha256) && migrationReceiptSha256 === installationBinding.migration_receipt_sha256
          && migrationReceipt.candidate_lock_sha256 === installationBinding.lock_sha256
          && HEX64.test(projectSha256) && migrationReceipt.prior_project_sha256 === projectSha256, "Verified exact migration receipt is required for prior managed roles");
        assert(Array.isArray(migrationReceipt.previous_managed_roles) && migrationReceipt.previous_managed_roles.every(row =>
          typeof row.name === "string" && row.name && typeof row.path === "string" && row.path && HEX64.test(row.sha256)
          && HEX64.test(row.binding_digest) && row.generation === generation), "Migration role ownership proof is incomplete");
        const names = migrationReceipt.previous_managed_roles.map(row => row.name);
        assert(new Set(names).size === names.length && sameNames(names, installationBinding.previous_managed_roles), "Migration receipt managed-role set mismatch");
        managed.push(...names);
      }
      const removedUnowned = project.custom_agents.roles.filter(role => !installationBinding.roles.includes(role) && !managed.includes(role));
      assert(!removedUnowned.length, "Preserve or explicitly reconcile externally owned roles before update: " + removedUnowned.join(", "));
      state.custom_agents.roles = [...installationBinding.roles];
    }
  }
  state.orchestration.runtime_restart_required = true;
  state.orchestration.status = "runtime_restart_required";
  state.orchestration.current_run_id = null;
  if (reference) state.installation_binding_ref = reference;
  state.updated_at = now;
  return {action: "CAPABILITY_UPDATE_PREPARED", state, previous_generation: generation, generation: generation + 1, installation_binding_ref: reference};
}

async function records(root, directory) {
  const folder = path.join(root, ".woia", directory);
  let entries;
  try {entries = await readdir(folder, {withFileTypes: true});} catch (error) {if (error.code === "ENOENT") return []; throw error;}
  const out = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), "Project state contains a symlink/reparse entry: " + directory + "/" + entry.name);
    if (entry.isDirectory()) out.push(...await records(root, directory + "/" + entry.name));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      const file = path.join(folder, entry.name);
      out.push({file, value: JSON.parse(await readFile(file, "utf8"))});
    }
  }
  return out;
}

async function save(file, value) {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = file + ".tmp-" + randomUUID();
  try {await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag: "wx"}); await rename(temporary, file);}
  finally {await rm(temporary, {force: true});}
}

/** Installed Core module API. Global publishes its own binding within its transaction. */
export async function applyInstallationBindingUpdate({root, expectedGeneration, expectedProjectSha256, installationBinding = null, nextCoreVersion, bootstrapReconciliation = null, migrationReceiptFile = null}) {
  root = path.resolve(root);
  assert(Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 0 && HEX64.test(expectedProjectSha256), "Exact Project generation and byte hash are required for update CAS");
  return withRuntimeLifecycleLock(root, async root => {
    const projectFile = path.join(root, ".woia", "project.json");
    const raw = await readFile(projectFile, "utf8"), project = JSON.parse(raw);
    assert(hash(raw) === expectedProjectSha256 && project.custom_agents.materialized_generation === expectedGeneration, "Project capability-update CAS conflict");
    if (installationBinding) assert(path.resolve(installationBinding.root) === root, "Installation binding destination mismatch");
    let migrationReceipt = null, migrationReceiptSha256 = null;
    if (migrationReceiptFile) {
      const folder = path.join(root, ".woia", "distribution", "migrations"), file = path.resolve(migrationReceiptFile);
      const relative = path.relative(folder, file);
      assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Migration receipt must be in this Project's immutable migration collection");
      const bytes = await readFile(file, "utf8");
      migrationReceipt = JSON.parse(bytes);
      migrationReceiptSha256 = hash(bytes);
      assert(path.resolve(migrationReceipt.root) === root && migrationReceipt.prior_project_sha256 === expectedProjectSha256,
        "Migration receipt current Project/root does not match update CAS");
    }
    const [tasks, snapshots, overlays, effects, bindings, agents, sessions, runs, specializations] = await Promise.all(["tasks", "snapshots", "overlays", "effects", "bindings", "agents", "runtime/sessions", "runtime/runs", "specialization-bindings"].map(directory => records(root, directory)));
    const transition = previewCapabilityUpdate({project, installationBinding, nextCoreVersion, tasks: tasks.map(row => row.value), snapshots: snapshots.map(row => row.value), overlays: overlays.map(row => row.value), effects: effects.map(row => row.value), runs: runs.map(row => row.value), migrationReceipt, migrationReceiptSha256, projectSha256: expectedProjectSha256});
    if (transition.action === "UNCHANGED") return transition;
    if (bootstrapReconciliation) {
      const organizationRef = bootstrapReconciliation.organizationRef;
      assert(organizationRef === null || typeof organizationRef === "string", "Invalid bootstrap OrganizationRef");
      assert(organizationRef === null || project.project.organization_ref == null || organizationRef === project.project.organization_ref, "OrganizationRef conflicts with existing Project");
      if (organizationRef !== null) transition.state.project.organization_ref = organizationRef;
      transition.state.root_agent_binding = {status: "bound", instructions_file: "AGENTS.md", managed_block_id: "WOIA_PROJECT_OPERATING_CONTRACT", last_reconciled_at: transition.state.updated_at};
    }
    // Invalidate execution first. If retirement is interrupted, old bindings fail the generation gate.
    await save(projectFile, transition.state);
    for (const row of specializations.filter(row => row.value.status === "active")) {
      row.value.status = "stale";
      row.value.loaded_generation = null;
      row.value.revision++;
      await save(row.file, row.value);
    }
    for (const row of bindings.filter(row => ["planned", "active"].includes(row.value.state))) {
      row.value.state = "stale";
      row.value.loaded_generation = null;
      row.value.revision++;
      await save(row.file, row.value);
    }
    for (const row of agents.filter(row => row.value.active_binding_ref)) {
      row.value.active_binding_ref = null;
      row.value.revision++;
      await save(row.file, row.value);
    }
    for (const row of sessions.filter(row => row.value.state === "active")) {
      row.value.state = "closed";
      row.value.loaded_generation = null;
      await save(row.file, row.value);
    }
    const currentFile = path.join(root, ".woia", "runtime", "current-session.json");
    try {
      const current = JSON.parse(await readFile(currentFile, "utf8"));
      current.state = "closed";
      current.loaded_generation = null;
      await save(currentFile, current);
    } catch (error) {if (error.code !== "ENOENT") throw error;}
    return {...transition, action: "INSTALLATION_BINDING_UPDATED"};
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const values = new Map();
    const allowed = new Set(["--root", "--expected-generation", "--expected-project-sha256", "--binding", "--core-version", "--migration-receipt"]);
    for (let i = 2; i < process.argv.length; i += 2) {
      assert(allowed.has(process.argv[i]) && process.argv[i + 1] !== undefined && !values.has(process.argv[i]), "Invalid capability-update argument");
      values.set(process.argv[i], process.argv[i + 1]);
    }
    assert(values.has("--root") && values.has("--binding"), "--root and --binding are required");
    const installationBinding = JSON.parse(await readFile(values.get("--binding"), "utf8"));
    console.log(JSON.stringify(await applyInstallationBindingUpdate({root: values.get("--root"), expectedGeneration: Number(values.get("--expected-generation")), expectedProjectSha256: values.get("--expected-project-sha256"), installationBinding, nextCoreVersion: values.get("--core-version"), migrationReceiptFile: values.get("--migration-receipt")})));
  } catch (error) {console.error("woia:capability-update: FAIL: " + error.message); process.exitCode = 1;}
}
