import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

const ref = (kind, id) => ({ kind, id });
const digest = value => createHash("sha256").update(value).digest("hex");
const id = prefix => `${prefix}-${randomUUID()}`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const json = file => readFile(file, "utf8").then(JSON.parse);
const recordPath = (root, directory, identity) => path.join(root, ".woia", directory, `${digest(identity)}.json`);

async function maybeJson(file) {
  try { return await json(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function sessionState(root) {
  const pointer = await maybeJson(path.join(root, ".woia", "runtime", "current-session.json"));
  if (!pointer) return null;
  const state = await maybeJson(recordPath(root, "runtime/sessions", pointer.id));
  assert(state?.id === pointer.id, "Current root-session record is incomplete; do not delegate");
  return state;
}

async function save(file, value, exclusive = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) return writeFile(file, bytes, { flag: "wx" });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function records(root, directory) {
  const dir = path.join(root, ".woia", directory);
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter(file => file.endsWith(".json"));
  return Promise.all(files.map(async file => ({ file: path.join(dir, file), value: await json(path.join(dir, file)) })));
}

async function find(root, directory, identity, schema) {
  const matches = (await records(root, directory)).filter(row => row.value.id === identity && row.value.schema === schema);
  assert(matches.length === 1, `Expected one ${schema} record for ${identity}, found ${matches.length}`);
  return matches[0];
}

// Serialize only local transitions. No native host operation occurs while holding this lock.
async function acquireLock(root, name) {
  const directory = path.join(root, ".woia", "runtime");
  const lock = path.join(directory, name);
  const staged = path.join(directory, `${name}-${randomUUID()}.pending`);
  const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  await mkdir(staged);
  try {
    await save(path.join(staged, "owner.json"), owner, true);
    // Publish a nonempty lock directory atomically; a crash cannot leave an ownerless lock.
    await rename(staged, lock);
  } catch (error) {
    if (await maybeJson(path.join(lock, "owner.json"))) throw new Error("Runtime lifecycle is busy or interrupted; do not create a thread. Reconcile the owning operation before retry.");
    throw error;
  } finally { await rm(staged, { recursive: true, force: true }); }
  return lock;
}

async function locked(root, operation, { allowRecovery = false } = {}) {
  root = path.resolve(root);
  await mkdir(path.join(root, ".woia", "runtime"), { recursive: true });
  const recoveryLock = path.join(root, ".woia", "runtime", "recovery.lock", "owner.json");
  assert(!await maybeJson(recoveryLock), "Runtime lock recovery is in progress; do not create a thread");
  const lock = await acquireLock(root, "lifecycle.lock");
  try {
    assert(!await maybeJson(recoveryLock), "Runtime lock recovery is in progress; do not create a thread");
    if (!allowRecovery) assert(!await maybeJson(path.join(root, ".woia", "runtime", "recovery.json")), "An interrupted lifecycle requires its new root-session recovery before further operations");
    return await operation(root);
  } finally { await rm(lock, { recursive: true }); }
}

function assertDeadOwner(owner) {
  assert(owner && owner.hostname === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string", "Cannot verify the abandoned lock owner on this host");
  try { process.kill(owner.pid, 0); } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error(`Cannot establish that lock owner ${owner.pid} is dead: ${error.code}`);
  }
  throw new Error(`Lock owner ${owner.pid} is still alive; recovery is forbidden`);
}

export async function recoverAbandonedLock({ root, sessionId = id("session") }) {
  root = path.resolve(root);
  const runtime = path.join(root, ".woia", "runtime");
  const session = await sessionState(root);
  const existingNotice = await maybeJson(path.join(runtime, "recovery.json"));
  if (existingNotice) assert(existingNotice.new_session_id === sessionId, "Continue recovery with its already recorded new root-session identity");
  const known = await maybeJson(recordPath(root, "runtime/sessions", sessionId));
  assert(typeof sessionId === "string" && sessionId.trim() && (existingNotice
    ? !known || known.state === "active"
    : sessionId !== session?.id && !known), "Lock recovery requires a new real root-session identity or its recorded incomplete recovery");
  // Recovery is explicitly requested, never a timeout-based takeover of a live operation.
  const recoveryPath = path.join(runtime, "recovery.lock");
  const abandonedRecovery = await maybeJson(path.join(recoveryPath, "owner.json"));
  if (abandonedRecovery) {
    assertDeadOwner(abandonedRecovery);
    // A deterministic, nonempty tombstone makes reclamation single-winner: another
    // caller cannot move a newer live lock to this already occupied destination.
    const retired = path.join(runtime, `retired-recovery-${digest(abandonedRecovery.token)}`);
    await rename(recoveryPath, retired);
    assert((await json(path.join(retired, "owner.json"))).token === abandonedRecovery.token, "Recovery lock identity changed; do not continue");
  }
  const recoveryLock = await acquireLock(root, "recovery.lock");
  try {
    const lock = path.join(runtime, "lifecycle.lock");
    const owner = await maybeJson(path.join(lock, "owner.json")) ?? existingNotice?.owner;
    assertDeadOwner(owner);
    const notice = existingNotice ? { ...existingNotice, owner } : { old_session_id: session?.id ?? null, new_session_id: sessionId, reason: `Interrupted lifecycle operation owned by exited process ${owner.pid}`, owner };
    await save(path.join(runtime, "recovery.json"), notice);
    const observed = await maybeJson(path.join(lock, "owner.json"));
    if (observed) {
      assert(observed.token === owner.token, "Lock ownership changed; recovery is forbidden");
      await rename(lock, path.join(runtime, `retired-lifecycle-${digest(owner.token)}`));
    }
    return { action: "LOCK_RECOVERED", fresh_root_session_required: true, session_id: sessionId };
  } finally { await rm(recoveryLock, { recursive: true }); }
}

async function currentSession(root, sessionId, recovering = false) {
  if (!recovering) assert(!await maybeJson(path.join(root, ".woia", "runtime", "recovery.json")), "An interrupted lifecycle requires its new root-session recovery before delegation");
  const session = await sessionState(root);
  assert(session && session.id === sessionId && session.state === "active", "Root session is not current and active; start a fresh root session.");
  return session;
}

async function saveSession(root, session) {
  await save(recordPath(root, "runtime/sessions", session.id), session);
  await save(path.join(root, ".woia", "runtime", "current-session.json"), session);
}

async function retireSession(root, session) {
  // Close the session before projections, so an interrupted rollover cannot execute old bindings.
  session.state = "closed";
  await saveSession(root, session);
  for (const row of await records(root, "bindings")) {
    if (row.value.root_session_id === session.id && ["planned", "active"].includes(row.value.state)) {
      row.value.state = "stale";
      row.value.revision++;
      await save(row.file, row.value);
    }
  }
  for (const row of await records(root, "agents")) {
    if (row.value.schema === "dev.woia.agent-instance/v1" && row.value.active_binding_ref) {
      row.value.active_binding_ref = null;
      row.value.revision++;
      await save(row.file, row.value);
    }
  }
}

export async function startSession({ root, sessionId = id("session"), loadedGeneration = null }) {
  return locked(root, async root => {
    assert(typeof sessionId === "string" && sessionId.trim().length > 0, "A root-session identity is required");
    assert(loadedGeneration === null || Number.isSafeInteger(loadedGeneration) && loadedGeneration >= 0, "Invalid observed loaded generation");
    await json(path.join(root, ".woia", "project.json"));
    const current = await sessionState(root);
    const recoveryFile = path.join(root, ".woia", "runtime", "recovery.json");
    const recovery = await maybeJson(recoveryFile);
    if (recovery) assert(recovery.new_session_id === sessionId, "Use the new root-session identity recorded by lock recovery");
    const known = await maybeJson(recordPath(root, "runtime/sessions", sessionId));
    if (known) {
      assert(known.state === "active" && (current?.id === sessionId || current?.state === "closed" || current === null), "A closed or previous root-session identity cannot be reactivated");
      assert(known.loaded_generation === loadedGeneration, "Cannot replace the observed loaded generation within a root session");
      await saveSession(root, known);
      if (recovery) await rm(recoveryFile);
      return { action: "SESSION_REUSED", session: known };
    }
    if (current) {
      if (current.state === "active") {
        const incompleteFailures = Object.entries(current.failed_agents ?? {}).filter(([, failure]) => !failure?.complete).map(([agentId]) => agentId);
        const affected = new Set([...incompleteFailures, ...(recovery ? Object.keys(current.bindings) : [])]);
        for (const agentId of affected) await block(await context(root, current.id, agentId, true), recovery?.reason ?? "Complete interrupted failure recovery before session rollover");
      }
      await retireSession(root, await sessionState(root));
    }
    // Legacy records without a root-session identity are history, never current runtime proof.
    for (const row of await records(root, "agents")) {
      if (row.value.schema === "dev.woia.agent-instance/v1" && row.value.active_binding_ref) {
        row.value.active_binding_ref = null;
        row.value.revision++;
        await save(row.file, row.value);
      }
    }
    for (const row of await records(root, "bindings")) {
      if (["planned", "active"].includes(row.value.state)) {
        row.value.state = "stale";
        row.value.revision++;
        await save(row.file, row.value);
      }
    }
    const session = { id: sessionId, state: "active", loaded_generation: loadedGeneration, bindings: {}, failed_agents: {}, started_at: new Date().toISOString() };
    await saveSession(root, session);
    if (recovery) await rm(recoveryFile);
    return { action: "SESSION_STARTED", session };
  }, { allowRecovery: true });
}

export async function closeSession({ root, sessionId }) {
  return locked(root, async root => {
    const session = await currentSession(root, sessionId);
    await retireSession(root, session);
    return { action: "SESSION_CLOSED", session };
  });
}

async function context(root, sessionId, agentId, recovering = false) {
  const session = await currentSession(root, sessionId, recovering);
  const agent = await find(root, "agents", agentId, "dev.woia.agent-instance/v1");
  assert(agent.value.lifecycle !== "archived", "An archived AgentInstance cannot delegate");
  const task = await find(root, "tasks", agent.value.task_ref.id, "dev.woia.task/v1");
  const allBindings = await records(root, "bindings");
  const matches = allBindings.filter(row => row.value.agent_instance_ref.id === agentId && row.value.root_session_id === sessionId);
  const binding = matches[0] ?? null;
  const reservation = Object.hasOwn(session.bindings, agentId) ? session.bindings[agentId] : null;
  const consistencyError = matches.length > 1 ? "Multiple same-session bindings detected"
    : reservation !== (binding?.value.id ?? null) ? "Interrupted or inconsistent runtime reservation" : null;
  return { root, session, agent, task, binding, allBindings, matches, consistencyError };
}

async function block(ctx, reason) {
  const { root, session, agent, task, binding } = ctx;
  const recovery = "Persist the continuation, start a fresh root session, verify the loaded generation, then activate this same AgentInstance lazily. Do not create a same-session sibling thread.";
  session.failed_agents ??= {};
  const priorFailure = Object.hasOwn(session.failed_agents, agent.value.id) ? session.failed_agents[agent.value.id] : null;
  const failure = priorFailure && typeof priorFailure === "object" ? priorFailure
    : { reason: priorFailure ?? reason, blocker_id: id("thread-blocker"), checkpoint_id: id("checkpoint"), created_at: new Date().toISOString() };
  const blocker = { id: failure.blocker_id, type: "custom-agent-runtime", summary: failure.reason, recovery };
  Object.defineProperty(session.failed_agents, agent.value.id, { value: failure, enumerable: true, configurable: true, writable: true });
  await saveSession(root, session);
  for (const row of ctx.matches) {
    if (row.value.state !== "failed") {
      row.value.state = "failed";
      row.value.revision++;
      row.value.limitations = [...new Set([...(row.value.limitations ?? []), failure.reason, recovery])];
      await save(row.file, row.value);
    }
  }
  if (agent.value.active_binding_ref) {
    agent.value.active_binding_ref = null;
    agent.value.revision++;
    await save(agent.file, agent.value);
  }
  let checkpointFile = recordPath(root, "checkpoints", failure.checkpoint_id);
  let savedCheckpoint = await maybeJson(checkpointFile);
  if (savedCheckpoint && (failure.complete || task.value.blockers.some(value => value.id === blocker.id))) {
    if (!failure.complete) { failure.complete = true; await saveSession(root, session); }
    return { action: "BLOCKED", fresh_root_session_required: true, blocker, checkpoint: savedCheckpoint, binding: binding?.value ?? null };
  }
  let previous = null;
  if (task.value.current_checkpoint_ref) previous = (await find(root, "checkpoints", task.value.current_checkpoint_ref.id, "dev.woia.checkpoint/v1")).value;
  const effects = (await records(root, "effects")).map(row => row.value).filter(value => value.task_ref?.id === task.value.id);
  const pendingUnknown = effects.filter(value => value.state === "unknown");
  if (savedCheckpoint && (savedCheckpoint.task_revision !== task.value.revision + 1
    || pendingUnknown.some(effect => !savedCheckpoint.unknown_effect_refs.some(value => value.id === effect.id)))) {
    // Another agent may have advanced this Task after our checkpoint was written but
    // before its Task pointer was saved. Preserve that snapshot and reconcile forward.
    failure.checkpoint_history = [...new Set([...(failure.checkpoint_history ?? []), savedCheckpoint.id])];
    failure.checkpoint_id = id("checkpoint");
    await saveSession(root, session);
    checkpointFile = recordPath(root, "checkpoints", failure.checkpoint_id);
    savedCheckpoint = null;
  }
  const history = await Promise.all((failure.checkpoint_history ?? []).map(async identity => (await find(root, "checkpoints", identity, "dev.woia.checkpoint/v1")).value));
  const continuations = [...history, previous].filter(Boolean);
  const strings = field => [...new Set(continuations.flatMap(value => value[field] ?? []))];
  const references = field => [...new Map(continuations.flatMap(value => value[field] ?? []).map(value => [`${value.kind ?? value.type}:${value.id}`, value])).values()];
  const unknownEffects = new Map(references("unknown_effect_refs").map(value => [value.id, value]));
  for (const effect of effects.filter(value => value.state === "unknown")) unknownEffects.set(effect.id, ref("EffectRecord", effect.id));
  task.value.revision++;
  const checkpoint = savedCheckpoint ?? {
    schema: "dev.woia.checkpoint/v1", id: failure.checkpoint_id, task_ref: ref("Task", task.value.id), task_revision: task.value.revision,
    task_state: "blocked", current_phase: task.value.current_phase || previous?.current_phase || "runtime-recovery", completed_units: strings("completed_units"),
    pending_units: [...new Set([...strings("pending_units"), `Resume AgentInstance ${agent.value.id} after root session ${session.id}`])],
    input_refs: references("input_refs"), artifact_refs: references("artifact_refs"),
    effect_refs: [...new Map([...references("effect_refs"), ...effects.map(value => ref("EffectRecord", value.id))].map(value => [value.id, value])).values()],
    unknown_effect_refs: [...unknownEffects.values()], resume_preconditions: [...new Set([...strings("resume_preconditions"), recovery])],
    next_action: { type: "human-action", summary: recovery, ref: ref("AgentInstance", agent.value.id) }, created_at: failure.created_at,
  };
  if (!savedCheckpoint) await save(checkpointFile, checkpoint, true);
  task.value.state = "blocked";
  task.value.blockers.push(blocker);
  task.value.current_checkpoint_ref = ref("Checkpoint", checkpoint.id);
  await save(task.file, task.value);
  failure.complete = true;
  await saveSession(root, session);
  return { action: "BLOCKED", fresh_root_session_required: true, blocker, checkpoint, binding: binding?.value ?? null };
}

async function generationValid(ctx) {
  const project = await json(path.join(ctx.root, ".woia", "project.json"));
  const materialized = project.custom_agents.materialized_generation;
  const loaded = project.custom_agents.loaded_generation;
  const valid = Number.isSafeInteger(materialized) && materialized >= 0 && loaded === materialized
    && ctx.session.loaded_generation === materialized && project.orchestration.runtime_restart_required === false
    && (!ctx.binding || ctx.binding.value.materialized_generation === materialized && ctx.binding.value.loaded_generation === loaded);
  return { valid, materialized, loaded };
}

export async function prepareDelegation({ root, sessionId, agentId, harness, threadStatus }) {
  return locked(root, async root => {
    const ctx = await context(root, sessionId, agentId);
    if (Object.hasOwn(ctx.session.failed_agents ?? {}, agentId) || ctx.consistencyError) return block(ctx, ctx.consistencyError ?? "Previous singleton failure requires recovery");
    const generation = await generationValid(ctx);
    if (!generation.valid) return block(ctx, "Loaded/materialized generation does not match the current root-session observation");
    if (!["ready", "active"].includes(ctx.task.value.state)) return { action: "WAIT_FOR_TASK", task_state: ctx.task.value.state, checkpoint_ref: ctx.task.value.current_checkpoint_ref };
    if (!ctx.binding) {
      assert(harness && typeof harness.type === "string" && harness.type && typeof harness.version === "string" && harness.version, "First activation requires observed harness type and version");
      const binding = {
        schema: "dev.woia.runtime-binding/v1", id: id("binding"), revision: 1,
        agent_instance_ref: ref("AgentInstance", agentId), task_ref: ref("Task", ctx.task.value.id),
        harness, root_session_id: sessionId, materialized_generation: generation.materialized, loaded_generation: generation.loaded,
        native_identifiers: {}, state: "planned", limitations: [],
      };
      // Reserve before returning permission for the external create operation. A crash is fail-closed.
      Object.defineProperty(ctx.session.bindings, agentId, { value: binding.id, enumerable: true, configurable: true, writable: true });
      await saveSession(root, ctx.session);
      await save(recordPath(root, "bindings", binding.id), binding, true);
      return { action: "CREATE_THREAD", binding };
    }
    const binding = ctx.binding.value;
    if (binding.state === "planned") return { action: "WAIT_FOR_THREAD", binding };
    if (binding.state !== "active" || threadStatus !== "usable") return block(ctx, `Current singleton is ${binding.state}; observed thread status: ${threadStatus ?? "unverified"}`);
    const thread = binding.native_identifiers.thread_id;
    if (!thread || ctx.allBindings.some(row => row.value.id !== binding.id && row.value.native_identifiers.thread_id === thread)) return block(ctx, "Native thread identity is missing or shared by independent bindings");
    const running = (await records(root, "runtime/runs")).some(row => row.value.binding_id === binding.id && row.value.state === "running");
    if (running) return { action: "WAIT_FOR_RUN", binding };
    ctx.agent.value.active_binding_ref = ref("HarnessRuntimeBinding", binding.id);
    ctx.agent.value.revision++;
    await save(ctx.agent.file, ctx.agent.value);
    const run = { id: id("run"), receipt_id: id("receipt"), agent_id: agentId, role: ctx.agent.value.role, task_id: ctx.task.value.id, session_id: sessionId,
      binding_id: binding.id, thread_id: thread, materialized_generation: generation.materialized, loaded_generation: generation.loaded, state: "running" };
    await save(recordPath(root, "runtime/runs", run.id), run, true);
    return { action: "DELEGATE", binding, run };
  });
}

export async function bindThread({ root, sessionId, agentId, bindingId, threadId }) {
  return locked(root, async root => {
    const ctx = await context(root, sessionId, agentId);
    if (ctx.consistencyError) return block(ctx, ctx.consistencyError);
    assert(!Object.hasOwn(ctx.session.failed_agents ?? {}, agentId), "This AgentInstance requires a fresh root session after its failure");
    assert(ctx.binding?.value.id === bindingId, "Native thread must match the reserved binding");
    const binding = ctx.binding.value;
    assert(binding.state === "planned", "The thread reservation has already been used or failed");
    if (!(await generationValid(ctx)).valid) return block(ctx, "Runtime generation changed during native thread creation");
    if (typeof threadId !== "string" || !threadId.trim() || ctx.allBindings.some(row => row.value.native_identifiers.thread_id === threadId)) return block(ctx, "Native thread identity is empty or already belongs to another binding/session");
    binding.native_identifiers.thread_id = threadId;
    binding.state = "active";
    binding.revision++;
    await save(ctx.binding.file, binding);
    ctx.agent.value.active_binding_ref = ref("HarnessRuntimeBinding", binding.id);
    ctx.agent.value.revision++;
    await save(ctx.agent.file, ctx.agent.value);
    return { action: "THREAD_BOUND", binding };
  });
}

export async function failThread({ root, sessionId, agentId, reason }) {
  return locked(root, async root => {
    assert(typeof reason === "string" && reason.trim(), "Record the exact causal failure");
    return block(await context(root, sessionId, agentId), reason);
  });
}

export async function recordReceipt({ root, receipt }) {
  return locked(root, async root => {
    assert(receipt?.schema === "dev.woia.execution-receipt/v1", "Expected an ExecutionReceipt");
    const file = recordPath(root, "runtime/runs", receipt.run_id);
    const run = await json(file);
    assert(receipt.receipt_id === run.receipt_id && receipt.role === run.role && receipt.agent_instance_ref?.kind === "AgentInstance" && receipt.agent_instance_ref.id === run.agent_id
      && receipt.task_ref?.kind === "Task" && receipt.task_ref.id === run.task_id && receipt.runtime?.binding_ref?.kind === "HarnessRuntimeBinding" && receipt.runtime.binding_ref.id === run.binding_id
      && receipt.runtime.materialized_generation === run.materialized_generation && receipt.runtime.loaded_generation === run.loaded_generation,
    "Receipt must match the root-issued run, AgentInstance, Task, binding and generation");
    assert(["PASS", "FINDINGS", "BLOCKED", "INCOMPLETE"].includes(receipt.result), "Invalid execution result");
    const receiptFile = recordPath(root, "receipts", receipt.receipt_id);
    const existing = await maybeJson(receiptFile);
    if (existing) assert(JSON.stringify(existing) === JSON.stringify(receipt), "A persisted receipt is immutable");
    else await save(receiptFile, receipt, true);
    run.state = "completed";
    await save(file, run);
    // Finishing a run never releases, closes or archives its native thread.
    return { action: "RECEIPT_RECORDED", receipt_file: receiptFile, run };
  });
}

const operations = { startSession, closeSession, recoverAbandonedLock, prepareDelegation, bindThread, failThread, recordReceipt };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, inputFile] = process.argv.slice(2);
    assert(Object.hasOwn(operations, operation) && inputFile, "Usage: node agent-thread-lifecycle.mjs <operation> <input.json>");
    console.log(JSON.stringify(await operations[operation](await json(path.resolve(inputFile))), null, 2));
  } catch (error) { console.error(`woia:agent-thread-lifecycle: FAIL: ${error.message}`); process.exitCode = 1; }
}
