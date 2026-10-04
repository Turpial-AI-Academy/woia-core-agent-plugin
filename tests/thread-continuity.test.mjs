import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

// Run authoring tests against either source or an independently extracted release payload.
// Host thread identities below are synthetic: this suite proves the source contract only.
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD_ROOT = path.resolve(process.env.WOIA_CORE_PAYLOAD_ROOT ?? SOURCE_ROOT);
const runtimeScript = name => pathToFileURL(path.join(PAYLOAD_ROOT, "skills", "project-runtime", "scripts", name)).href;
const { bootstrapProject } = await import(runtimeScript("bootstrap-project.mjs"));
const { startSession, closeSession, recoverAbandonedLock, prepareDelegation, bindThread, failThread, recordReceipt } =
  await import(runtimeScript("agent-thread-lifecycle.mjs"));
const GENERATION = 4;
const HARNESS = { type: "deterministic-test", version: "1" };
const BEGIN = "<!-- WOIA_PROJECT_OPERATING_CONTRACT:BEGIN -->";
const END = "<!-- WOIA_PROJECT_OPERATING_CONTRACT:END -->";
const ref = (kind, id) => ({ kind, id });
const json = file => readFile(file, "utf8").then(JSON.parse);
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
const projectPath = root => path.join(root, ".woia", "project.json");
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { "date-time": true } });
const schemaIds = new Map();
for (const file of (await readdir(path.join(PAYLOAD_ROOT, "dev.woia", "schemas"))).filter(file => file.endsWith(".schema.json"))) {
  const schema = await json(path.join(PAYLOAD_ROOT, "dev.woia", "schemas", file));
  ajv.addSchema(schema);
  schemaIds.set(file, schema.$id);
}

function valid(name, document) {
  const validate = ajv.getSchema(schemaIds.get(`${name}.schema.json`));
  assert.ok(validate, `Missing ${name} schema in ${PAYLOAD_ROOT}`);
  assert.equal(validate(document), true, `${name}: ${JSON.stringify(validate.errors)}`);
}

async function temporaryProject(t) {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "woia-thread-continuity-"));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith("woia-thread-continuity-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function records(root, directory) {
  const location = path.join(root, ".woia", directory);
  let files;
  try { files = await readdir(location); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter(file => file.endsWith(".json")).map(file => json(path.join(location, file))));
}

async function record(root, directory, id) {
  const found = (await records(root, directory)).filter(value => value.id === id);
  assert.equal(found.length, 1, `Expected one ${directory} record for ${id}`);
  return found[0];
}

async function fixture(t, { department = "marketing", agents = [{ id: "agent-a", role: "executor" }] } = {}) {
  const root = await temporaryProject(t);
  await bootstrapProject({ root, projectId: "project-continuity", department, orchestrator: `woia-${department}`, organizationRef: null });
  const project = await json(projectPath(root));
  project.custom_agents = { status: "loaded", materialized_generation: GENERATION, loaded_generation: GENERATION, roles: agents.map(agent => agent.id) };
  project.orchestration.status = "active";
  project.orchestration.current_task_id = "task-continuity";
  valid("project-state", project);
  await writeJson(projectPath(root), project);
  const task = {
    schema: "dev.woia.task/v1", id: "task-continuity", revision: 1, objective: "Prove session-scoped thread continuity",
    department, origin: { type: "human-request" }, workflow_profile: department === "software" ? "software-methodology" : "audited-execution",
    state: "active", current_phase: "execution", owner: { kind: "agent-instance", id: agents[0].id }, inputs: [], constraints: [],
    expected_outputs: ["deterministic source-contract evidence"], evidence_requirements: ["ExecutionReceipt"],
    capability_snapshot_refs: [], blockers: [], human_review: "pending", current_checkpoint_ref: null,
  };
  valid("task", task);
  await writeJson(path.join(root, ".woia", "tasks", `${task.id}.json`), task);
  for (const item of agents) {
    const definition = {
      schema: "dev.woia.agent-definition/v1", id: item.definitionId ?? `definition-${item.id}`, version: "0.5.0",
      role: item.role, purpose: "Deterministic lifecycle fixture", instructions: "Use the Core lifecycle contract",
      skill_refs: [], limits: ["No actual host or provider execution"],
    };
    const agent = {
      schema: "dev.woia.agent-instance/v1", id: item.id, revision: 1, definition_ref: ref("AgentDefinition", definition.id),
      task_ref: ref("Task", task.id), role: item.role, lifecycle: "active", authority_context_ref: null,
      memory_scope: { mode: "task-only", paths: [`.woia/tasks/${task.id}.json`] }, resource_scope: [],
      capability_snapshot_refs: [], active_binding_ref: null,
    };
    valid("agent-definition", definition);
    valid("agent-instance", agent);
    await writeJson(path.join(root, ".woia", "agents", `${definition.id}.json`), definition);
    await writeJson(path.join(root, ".woia", "agents", `${agent.id}.json`), agent);
  }
  return { root, task, agents, project };
}

const delegation = (root, sessionId, agentId, options = {}) =>
  prepareDelegation({ root, sessionId, agentId, harness: HARNESS, threadStatus: "usable", ...options });

async function activate(root, sessionId, agentId, threadId) {
  const reservation = await delegation(root, sessionId, agentId);
  assert.equal(reservation.action, "CREATE_THREAD");
  valid("runtime-binding", reservation.binding);
  assert.equal(reservation.binding.root_session_id, sessionId);
  assert.deepEqual(reservation.binding.native_identifiers, {});
  const bound = await bindThread({ root, sessionId, agentId, bindingId: reservation.binding.id, threadId });
  assert.equal(bound.action, "THREAD_BOUND");
  valid("runtime-binding", bound.binding);
  assert.equal(bound.binding.id, reservation.binding.id);
  assert.equal(bound.binding.native_identifiers.thread_id, threadId);
  return bound.binding;
}

function receiptFor(result, role = "executor", phase = "execution") {
  const { run } = result;
  const receipt = {
    schema: "dev.woia.execution-receipt/v1", receipt_id: run.receipt_id, run_id: run.id,
    task_ref: ref("Task", run.task_id), phase, role, agent_instance_ref: ref("AgentInstance", run.agent_id),
    execution: { kind: "provider", provider: { plugin: "woia-test-provider", marketplace: "woia-test-marketplace", version: "0.5.0", selector: "test-fixture", skill: "test-provider" }, explicit_skill_invocation: "$test-provider" },
    runtime: { binding_ref: ref("HarnessRuntimeBinding", run.binding_id), materialized_generation: run.materialized_generation, loaded_generation: run.loaded_generation },
    source: { input_anchor: null, output_anchor: null, reason: "Synthetic receipt for deterministic source-contract verification" },
    result: "PASS", outputs: [], evidence: ["Synthetic host identity; real-host Operator E2E remains pending"], effects: [],
    gate: { status: "satisfied", items: [] }, blockers: [],
  };
  valid("execution-receipt", receipt);
  return receipt;
}

async function completeRun(root, sessionId, agentId, role = "executor", phase = "execution") {
  const result = await delegation(root, sessionId, agentId);
  assert.equal(result.action, "DELEGATE");
  valid("runtime-binding", result.binding);
  const receipt = receiptFor(result, role, phase);
  const saved = await recordReceipt({ root, receipt });
  assert.equal(saved.action, "RECEIPT_RECORDED");
  assert.equal(saved.run.state, "completed");
  assert.deepEqual(await json(saved.receipt_file), receipt);
  const binding = await record(root, "bindings", result.binding.id);
  assert.equal(binding.state, "active", "Completing a run must keep its thread available");
  assert.equal(binding.native_identifiers.thread_id, result.run.thread_id);
  return result;
}

async function assertStoredReceipts(root, expected) {
  const receipts = await records(root, "receipts");
  assert.equal(receipts.length, expected);
  assert.equal(new Set(receipts.map(receipt => receipt.receipt_id)).size, expected);
  assert.equal(new Set(receipts.map(receipt => receipt.run_id)).size, expected);
  for (const receipt of receipts) valid("execution-receipt", receipt);
}

// Faults stay in a child process. The installed helper has no fault-injection hook.
const FAULT_LOADER = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const input = JSON.parse(await fs.promises.readFile(process.argv[2], "utf8"));
let hits = 0;
globalThis.woiaFaultHits = () => hits;
if (input.fault.kind === "kill-eperm") {
  const original = process.kill;
  process.kill = function(pid, signal) {
    if (pid === input.fault.pid && signal === 0) {
      hits++;
      throw Object.assign(new Error("Injected inaccessible lock owner"), { code: "EPERM" });
    }
    return original.call(this, pid, signal);
  };
} else {
  const original = fs.promises.writeFile;
  const target = path.join(input.args.root, ".woia", ...input.fault.target);
  fs.promises.writeFile = async function(file, ...rest) {
    const candidate = path.resolve(String(file));
    const matches = input.fault.prefix ? candidate.startsWith(target) : candidate.startsWith(target + path.sep);
    if (hits === 0 && matches) {
      hits++;
      if (input.fault.kind === "write-eio") throw Object.assign(new Error("Injected transient write failure"), { code: "EIO" });
      process.send({ event: "WRITE_HELD", pid: process.pid, file: candidate });
      await new Promise(() => {});
    }
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
}
`;

const FAULT_DRIVER = `
import { readFile } from "node:fs/promises";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const runtime = await import(input.runtime);
const keepAlive = input.fault.kind === "hold-write" ? setInterval(() => {}, 1000) : null;
try {
  const result = await runtime[input.operation](input.args);
  console.log(JSON.stringify({ ok: true, result, hits: globalThis.woiaFaultHits() }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { name: error.name, code: error.code ?? null, message: error.message }, hits: globalThis.woiaFaultHits() }));
} finally { if (keepAlive) clearInterval(keepAlive); }
`;

async function faultArguments(root, operation, args, fault) {
  const directory = await mkdtemp(path.join(root, "fault-harness-"));
  const loader = path.join(directory, "loader.mjs");
  const driver = path.join(directory, "driver.mjs");
  const input = path.join(directory, "input.json");
  await writeFile(loader, FAULT_LOADER);
  await writeFile(driver, FAULT_DRIVER);
  await writeJson(input, { runtime: runtimeScript("agent-thread-lifecycle.mjs"), operation, args: { root, ...args }, fault });
  return ["--import", pathToFileURL(loader).href, driver, input];
}

async function faultOperation(root, operation, args, fault) {
  const argv = await faultArguments(root, operation, args, fault);
  const { stdout } = await promisify(execFile)(process.execPath, argv, { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout);
}

async function holdOperation(root, operation, args, fault) {
  const argv = await faultArguments(root, operation, args, { ...fault, kind: "hold-write" });
  const child = spawn(process.execPath, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let closed = false;
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }));
  const stop = async () => {
    if (!closed) child.kill("SIGKILL");
    await exited;
  };
  let timer;
  try {
    const event = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("close", () => reject(new Error(`Fault child exited before holding its write: ${output}`)));
      timer = setTimeout(() => reject(new Error("Fault child did not reach the selected write")), 10000);
    });
    assert.equal(event.event, "WRITE_HELD");
    assert.equal(event.pid, child.pid);
    return { pid: child.pid, event, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally { clearTimeout(timer); }
}

test("A: three runs reuse one AgentInstance, current-session binding and native thread", async t => {
  const { root } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const binding = await activate(root, "S1", "agent-a", "thread-a-S1");
  const results = [];
  for (let index = 0; index < 3; index++) results.push(await completeRun(root, "S1", "agent-a"));
  assert.equal(new Set(results.map(result => result.run.id)).size, 3);
  assert.equal(new Set(results.map(result => result.run.receipt_id)).size, 3);
  assert.equal(new Set(results.flatMap(result => [result.run.id, result.run.receipt_id, result.run.thread_id])).size, 7);
  for (const result of results) {
    assert.equal(result.run.binding_id, binding.id);
    assert.equal(result.run.thread_id, "thread-a-S1");
    assert.equal(result.run.agent_id, "agent-a");
  }
  const agents = (await records(root, "agents")).filter(value => value.schema === "dev.woia.agent-instance/v1");
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].active_binding_ref, ref("HarnessRuntimeBinding", binding.id));
  const bindings = await records(root, "bindings");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].state, "active");
  assert.equal(bindings[0].root_session_id, "S1");
  assert.equal((await records(root, "runtime/runs")).length, 3);
  await assertStoredReceipts(root, 3);
});

test("B: OPEA-H Executor and Auditor remain independent and each reuses its own thread", async t => {
  const { root } = await fixture(t, { agents: [{ id: "executor", role: "executor" }, { id: "auditor", role: "auditor" }] });
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const executor = await activate(root, "S1", "executor", "thread-executor");
  const auditor = await activate(root, "S1", "auditor", "thread-auditor");
  assert.notEqual(executor.id, auditor.id);
  assert.notEqual(executor.native_identifiers.thread_id, auditor.native_identifiers.thread_id);
  for (const [agentId, role, binding] of [["executor", "executor", executor], ["auditor", "auditor", auditor]]) {
    const first = await completeRun(root, "S1", agentId, role);
    const second = await completeRun(root, "S1", agentId, role);
    assert.equal(second.run.binding_id, binding.id);
    assert.equal(second.run.thread_id, first.run.thread_id);
    assert.notEqual(second.run.id, first.run.id);
    assert.notEqual(second.run.receipt_id, first.run.receipt_id);
  }
  assert.equal((await records(root, "bindings")).length, 2);
  await assertStoredReceipts(root, 4);
});

test("singleton identity is AgentInstance plus session, not shared AgentDefinition", async t => {
  const agents = ["instance-one", "instance-two"].map(id => ({ id, role: "executor", definitionId: "shared-definition" }));
  const { root } = await fixture(t, { agents });
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const first = await activate(root, "S1", agents[0].id, "thread-one");
  const second = await activate(root, "S1", agents[1].id, "thread-two");
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.native_identifiers.thread_id, second.native_identifiers.thread_id);
  const instances = (await records(root, "agents")).filter(value => value.schema === "dev.woia.agent-instance/v1");
  assert.equal(instances.length, 2);
  assert.equal(new Set(instances.map(value => value.definition_ref.id)).size, 1);
  for (const agent of agents) await completeRun(root, "S1", agent.id);
  await assertStoredReceipts(root, 2);
});

async function seedContinuation(root, task, { unknownEffect = false } = {}) {
  const effect = {
    schema: "dev.woia.effect-record/v1", id: "effect-preserved", task_ref: ref("Task", task.id), run_id: "prior-run",
    effect_key: "prior-effect", effect_class: "communication", action: { capability: "test-capability", operation: "send", target_ref: "synthetic:target" },
    action_digest: `sha256:${"a".repeat(64)}`, state: "unknown", observed_at: "2026-10-04T12:00:00Z", evidence: ["Synthetic unknown outcome"], prior_effect_ref: null, transition: "observation",
  };
  if (unknownEffect) {
    valid("effect-record", effect);
    await writeJson(path.join(root, ".woia", "effects", `${effect.id}.json`), effect);
  }
  const checkpoint = {
    schema: "dev.woia.checkpoint/v1", id: "checkpoint-preserved", task_ref: ref("Task", task.id), task_revision: task.revision,
    task_state: task.state, current_phase: "execution", completed_units: ["first-work-unit"], pending_units: ["next-work-unit"],
    input_refs: [{ type: "input", id: "input-preserved" }], artifact_refs: [{ type: "evidence", id: "artifact-preserved" }],
    effect_refs: unknownEffect ? [ref("EffectRecord", effect.id)] : [], unknown_effect_refs: unknownEffect ? [ref("EffectRecord", effect.id)] : [],
    resume_preconditions: unknownEffect ? ["Reconcile prior unknown effect"] : [],
    next_action: { type: unknownEffect ? "reconcile" : "resume", summary: "Continue durable Task", ref: ref("Task", task.id) }, created_at: "2026-10-04T12:01:00Z",
  };
  valid("checkpoint", checkpoint);
  await writeJson(path.join(root, ".woia", "checkpoints", `${checkpoint.id}.json`), checkpoint);
  task.current_checkpoint_ref = ref("Checkpoint", checkpoint.id);
  await writeJson(path.join(root, ".woia", "tasks", `${task.id}.json`), task);
  return checkpoint;
}

test("C: a fresh root session preserves durable identity and continuation but replaces binding/thread", async t => {
  const { root, task, project } = await fixture(t);
  const checkpoint = await seedContinuation(root, task);
  const instructions = await readFile(path.join(root, "AGENTS.md"), "utf8");
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const firstBinding = await activate(root, "S1", "agent-a", "thread-a-S1");
  await completeRun(root, "S1", "agent-a");
  await completeRun(root, "S1", "agent-a");
  const agentBefore = await record(root, "agents", "agent-a");
  assert.equal((await closeSession({ root, sessionId: "S1" })).action, "SESSION_CLOSED");
  assert.equal((await record(root, "bindings", firstBinding.id)).state, "stale");
  assert.equal((await record(root, "agents", "agent-a")).active_binding_ref, null);
  await assert.rejects(() => delegation(root, "S1", "agent-a"));
  await startSession({ root, sessionId: "S2", loadedGeneration: GENERATION });
  assert.equal((await record(root, "agents", "agent-a")).active_binding_ref, null);
  assert.equal((await records(root, "bindings")).length, 1, "S2 must materialize lazily");
  assert.deepEqual(await json(projectPath(root)), project);
  assert.deepEqual(await record(root, "tasks", task.id), task);
  assert.deepEqual(await record(root, "checkpoints", checkpoint.id), checkpoint);
  assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), instructions);
  const agentAfter = await record(root, "agents", "agent-a");
  for (const key of ["id", "definition_ref", "task_ref", "role", "memory_scope", "resource_scope", "capability_snapshot_refs"]) assert.deepEqual(agentAfter[key], agentBefore[key]);
  const secondBinding = await activate(root, "S2", "agent-a", "thread-a-S2");
  assert.notEqual(secondBinding.id, firstBinding.id);
  assert.notEqual(secondBinding.native_identifiers.thread_id, firstBinding.native_identifiers.thread_id);
  for (let index = 0; index < 2; index++) {
    const result = await completeRun(root, "S2", "agent-a");
    assert.equal(result.run.binding_id, secondBinding.id);
    assert.equal(result.run.thread_id, "thread-a-S2");
  }
  await assert.rejects(() => startSession({ root, sessionId: "S1", loadedGeneration: GENERATION }));
  assert.deepEqual((await record(root, "agents", "agent-a")).active_binding_ref, ref("HarnessRuntimeBinding", secondBinding.id));
  assert.equal((await records(root, "bindings")).filter(binding => binding.state === "active").length, 1);
  await assertStoredReceipts(root, 4);
});

test("D: failed, unverified and capacity-blocked singletons checkpoint without a same-session replacement", async t => {
  for (const failure of ["lost", "capacity-before-bind", "capacity-before-reservation", "unverified", "failed"]) {
    await t.test(failure, async t => {
      const { root, task } = await fixture(t);
      const previous = await seedContinuation(root, task, { unknownEffect: true });
      await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
      let binding = null;
      if (failure === "capacity-before-bind") {
        const prepared = await delegation(root, "S1", "agent-a");
        assert.equal(prepared.action, "CREATE_THREAD");
        binding = prepared.binding;
      } else if (failure !== "capacity-before-reservation") binding = await activate(root, "S1", "agent-a", "thread-failed");
      const blocked = ["unverified", "failed"].includes(failure)
        ? await delegation(root, "S1", "agent-a", { threadStatus: failure === "unverified" ? undefined : "failed" })
        : await failThread({ root, sessionId: "S1", agentId: "agent-a", reason: failure });
      assert.equal(blocked.action, "BLOCKED");
      assert.equal(blocked.fresh_root_session_required, true);
      valid("checkpoint", blocked.checkpoint);
      assert.deepEqual(blocked.checkpoint.completed_units, previous.completed_units);
      assert.ok(blocked.checkpoint.pending_units.includes("next-work-unit"));
      assert.deepEqual(blocked.checkpoint.artifact_refs, previous.artifact_refs);
      assert.deepEqual(blocked.checkpoint.unknown_effect_refs, previous.unknown_effect_refs);
      assert.ok(blocked.checkpoint.resume_preconditions.includes("Reconcile prior unknown effect"));
      assert.equal(blocked.checkpoint.next_action.type, "human-action");
      assert.deepEqual(blocked.checkpoint.next_action.ref, ref("AgentInstance", "agent-a"));
      const blockedTask = await record(root, "tasks", task.id);
      valid("task", blockedTask);
      assert.equal(blockedTask.state, "blocked");
      assert.deepEqual(blockedTask.current_checkpoint_ref, ref("Checkpoint", blocked.checkpoint.id));
      assert.ok(blockedTask.blockers.some(value => value.id === blocked.blocker.id && value.recovery));
      assert.equal((await record(root, "agents", "agent-a")).active_binding_ref, null);
      for (let attempt = 0; attempt < 2; attempt++) {
        const repeated = await delegation(root, "S1", "agent-a");
        assert.equal(repeated.action, "BLOCKED");
        assert.equal(repeated.fresh_root_session_required, true);
      }
      const bindings = await records(root, "bindings");
      assert.equal(bindings.length, binding ? 1 : 0);
      if (binding) {
        valid("runtime-binding", bindings[0]);
        assert.equal(bindings[0].id, binding.id);
        assert.equal(bindings[0].state, "failed");
        assert.deepEqual(bindings[0].native_identifiers, binding.native_identifiers);
        await assert.rejects(() => bindThread({ root, sessionId: "S1", agentId: "agent-a", bindingId: binding.id, threadId: "duplicate-thread" }));
      }
      assert.equal((await records(root, "checkpoints")).length, 2, "Repeated activation must retain the continuation without checkpoint churn");
      assert.equal((await records(root, "runtime/runs")).length, 0);
      await startSession({ root, sessionId: "S2", loadedGeneration: GENERATION });
      const notReconciled = await delegation(root, "S2", "agent-a");
      assert.equal(notReconciled.action, "WAIT_FOR_TASK", "A new root session must not silently clear durable blockers");
      assert.equal((await records(root, "bindings")).length, binding ? 1 : 0);
      assert.deepEqual(await record(root, "checkpoints", blocked.checkpoint.id), blocked.checkpoint);
    });
  }
});

test("E: generation drift and a pending restart cannot reuse an otherwise usable thread", async t => {
  const mutations = [
    ["loaded mismatch", project => { project.custom_agents.loaded_generation = GENERATION - 1; }],
    ["loaded unknown", project => { project.custom_agents.loaded_generation = null; }],
    ["new materialization", project => { project.custom_agents.materialized_generation = GENERATION + 1; }],
    ["restart required", project => { project.orchestration.runtime_restart_required = true; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async t => {
      const { root } = await fixture(t);
      await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
      const binding = await activate(root, "S1", "agent-a", "thread-generation");
      await completeRun(root, "S1", "agent-a");
      const project = await json(projectPath(root));
      mutate(project);
      valid("project-state", project);
      await writeJson(projectPath(root), project);
      const blocked = await delegation(root, "S1", "agent-a");
      assert.equal(blocked.action, "BLOCKED");
      assert.equal(blocked.fresh_root_session_required, true);
      valid("checkpoint", blocked.checkpoint);
      const bindings = await records(root, "bindings");
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].id, binding.id);
      assert.equal(bindings[0].native_identifiers.thread_id, "thread-generation");
      assert.equal(bindings[0].state, "failed");
      assert.equal((await records(root, "runtime/runs")).length, 1);
      await assertStoredReceipts(root, 1);
    });
  }
});

test("failure before a thread reservation requires a fresh session even after explicit Task reconciliation", async t => {
  const { root, task } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const failed = await failThread({ root, sessionId: "S1", agentId: "agent-a", reason: "Synthetic host capacity exhausted before reservation" });
  assert.equal(failed.action, "BLOCKED");
  valid("checkpoint", failed.checkpoint);
  const reconciled = await record(root, "tasks", task.id);
  reconciled.revision++;
  reconciled.state = "active";
  reconciled.blockers = [];
  valid("task", reconciled);
  await writeJson(path.join(root, ".woia", "tasks", `${task.id}.json`), reconciled);
  assert.equal((await delegation(root, "S1", "agent-a")).action, "BLOCKED");
  assert.equal((await records(root, "bindings")).length, 0);
  await startSession({ root, sessionId: "S2", loadedGeneration: GENERATION });
  const binding = await activate(root, "S2", "agent-a", "thread-after-recovery");
  assert.equal(binding.root_session_id, "S2");
  await completeRun(root, "S2", "agent-a");
  assert.equal((await records(root, "bindings")).length, 1);
  assert.deepEqual(await record(root, "checkpoints", failed.checkpoint.id), failed.checkpoint);
  await assertStoredReceipts(root, 1);
});

test("unknown session generation fails closed before materialization and cannot be rewritten in place", async t => {
  const { root, task } = await fixture(t);
  task.current_phase = null;
  await writeJson(path.join(root, ".woia", "tasks", `${task.id}.json`), task);
  await startSession({ root, sessionId: "S1", loadedGeneration: null });
  const result = await delegation(root, "S1", "agent-a");
  assert.equal(result.action, "BLOCKED");
  valid("checkpoint", result.checkpoint);
  assert.equal(result.fresh_root_session_required, true);
  assert.equal((await records(root, "bindings")).length, 0);
  assert.equal((await records(root, "runtime/runs")).length, 0);
  await assert.rejects(() => startSession({ root, sessionId: "S1", loadedGeneration: GENERATION }));
  assert.equal((await delegation(root, "S1", "agent-a")).action, "BLOCKED");
});

test("generation changed between reservation and native-thread binding never permits delegation", async t => {
  const { root } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const reservation = await delegation(root, "S1", "agent-a");
  assert.equal(reservation.action, "CREATE_THREAD");
  const project = await json(projectPath(root));
  project.custom_agents.materialized_generation++;
  await writeJson(projectPath(root), project);
  const result = await bindThread({ root, sessionId: "S1", agentId: "agent-a", bindingId: reservation.binding.id, threadId: "thread-late" });
  assert.equal(result.action, "BLOCKED");
  valid("checkpoint", result.checkpoint);
  assert.equal((await delegation(root, "S1", "agent-a")).action, "BLOCKED");
  assert.equal((await records(root, "bindings")).length, 1);
  assert.equal((await records(root, "runtime/runs")).length, 0);
});

test("concurrent activation and repeated pending reservations permit only one native creation", async t => {
  const { root } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const outcomes = await Promise.allSettled([delegation(root, "S1", "agent-a"), delegation(root, "S1", "agent-a")]);
  const creations = outcomes.filter(value => value.status === "fulfilled" && value.value.action === "CREATE_THREAD");
  assert.equal(creations.length, 1);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") assert.ok(outcome.reason instanceof Error);
    else assert.ok(["CREATE_THREAD", "WAIT_FOR_THREAD"].includes(outcome.value.action));
  }
  const binding = creations[0].value.binding;
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await delegation(root, "S1", "agent-a");
    assert.equal(pending.action, "WAIT_FOR_THREAD");
    assert.equal(pending.binding.id, binding.id);
  }
  await bindThread({ root, sessionId: "S1", agentId: "agent-a", bindingId: binding.id, threadId: "thread-once" });
  await assert.rejects(() => bindThread({ root, sessionId: "S1", agentId: "agent-a", bindingId: binding.id, threadId: "thread-duplicate" }));
  const first = await delegation(root, "S1", "agent-a");
  assert.equal(first.action, "DELEGATE");
  assert.equal((await delegation(root, "S1", "agent-a")).action, "WAIT_FOR_RUN");
  await recordReceipt({ root, receipt: receiptFor(first) });
  const second = await completeRun(root, "S1", "agent-a");
  assert.equal(second.run.thread_id, first.run.thread_id);
  assert.notEqual(second.run.id, first.run.id);
  assert.equal((await records(root, "bindings")).length, 1);
  await assertStoredReceipts(root, 2);
});

test("receipts remain unique, correlated and immutable while their thread stays reusable", async t => {
  const { root } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  await activate(root, "S1", "agent-a", "thread-receipt");
  const result = await delegation(root, "S1", "agent-a");
  assert.equal(result.action, "DELEGATE");
  const receipt = receiptFor(result);
  for (const mutate of [
    value => { value.receipt_id = "receipt-wrong"; },
    value => { value.agent_instance_ref.id = "agent-wrong"; },
    value => { value.task_ref.id = "task-wrong"; },
    value => { value.runtime.binding_ref.id = "binding-wrong"; },
    value => { value.runtime.loaded_generation++; },
  ]) {
    const incorrect = structuredClone(receipt);
    mutate(incorrect);
    valid("execution-receipt", incorrect);
    await assert.rejects(() => recordReceipt({ root, receipt: incorrect }));
  }
  assert.equal((await records(root, "receipts")).length, 0);
  assert.equal((await delegation(root, "S1", "agent-a")).action, "WAIT_FOR_RUN");
  await recordReceipt({ root, receipt });
  await recordReceipt({ root, receipt });
  await assert.rejects(() => recordReceipt({ root, receipt: { ...receipt, result: "FINDINGS" } }));
  await completeRun(root, "S1", "agent-a");
  await assertStoredReceipts(root, 2);
});

test("independent bindings cannot adopt the same native thread identity", async t => {
  const { root } = await fixture(t, { agents: [{ id: "executor", role: "executor" }, { id: "auditor", role: "auditor" }] });
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const executor = await activate(root, "S1", "executor", "thread-shared-attempt");
  const auditor = await delegation(root, "S1", "auditor");
  assert.equal(auditor.action, "CREATE_THREAD");
  const rejected = await bindThread({ root, sessionId: "S1", agentId: "auditor", bindingId: auditor.binding.id, threadId: executor.native_identifiers.thread_id });
  assert.equal(rejected.action, "BLOCKED");
  valid("checkpoint", rejected.checkpoint);
  assert.equal((await delegation(root, "S1", "auditor")).action, "BLOCKED");
  const bindings = await records(root, "bindings");
  assert.equal(bindings.length, 2);
  assert.equal(bindings.filter(binding => binding.native_identifiers.thread_id === "thread-shared-attempt").length, 1);
});

test("legacy bindings without a root session remain history and cannot prove a current thread", async t => {
  const { root, task } = await fixture(t);
  const legacy = {
    schema: "dev.woia.runtime-binding/v1", id: "binding-legacy", revision: 1, agent_instance_ref: ref("AgentInstance", "agent-a"),
    task_ref: ref("Task", task.id), harness: HARNESS, materialized_generation: GENERATION, loaded_generation: GENERATION,
    native_identifiers: { thread_id: "thread-legacy" }, state: "active", limitations: [],
  };
  valid("runtime-binding", legacy);
  await writeJson(path.join(root, ".woia", "bindings", "legacy.json"), legacy);
  const agent = await record(root, "agents", "agent-a");
  agent.active_binding_ref = ref("HarnessRuntimeBinding", legacy.id);
  await writeJson(path.join(root, ".woia", "agents", `${agent.id}.json`), agent);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  assert.equal((await record(root, "agents", "agent-a")).active_binding_ref, null);
  const current = await activate(root, "S1", "agent-a", "thread-current");
  assert.notEqual(current.id, legacy.id);
  const run = await completeRun(root, "S1", "agent-a");
  assert.equal(run.run.binding_id, current.id);
  assert.notEqual(run.run.thread_id, legacy.native_identifiers.thread_id);
  const historical = await record(root, "bindings", legacy.id);
  valid("runtime-binding", historical);
  assert.equal(historical.state, "stale");
  assert.ok(historical.revision > legacy.revision);
  for (const key of ["id", "agent_instance_ref", "task_ref", "harness", "native_identifiers"]) assert.deepEqual(historical[key], legacy[key]);
});

test("Software uses Core continuity for Development and distinct review, testing, security and release QA instances", async t => {
  const agents = [
    { id: "software-development", role: "executor" },
    ...["code-review", "testing", "security", "release-qa"].map(role => ({ id: `software-${role}`, role: "auditor" })),
  ];
  const { root, task } = await fixture(t, { department: "software", agents });
  assert.equal(task.workflow_profile, "software-methodology");
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const development = await activate(root, "S1", agents[0].id, "thread-development");
  const results = [];
  for (const phase of ["development", "correction", "finalization"]) results.push(await completeRun(root, "S1", agents[0].id, "executor", phase));
  assert.equal(new Set(results.map(result => result.run.id)).size, 3);
  assert.equal(new Set(results.map(result => result.run.receipt_id)).size, 3);
  assert.ok(results.every(result => result.run.binding_id === development.id && result.run.thread_id === "thread-development"));
  const bindings = [development];
  for (const agent of agents.slice(1)) {
    bindings.push(await activate(root, "S1", agent.id, `thread-${agent.id}`));
    await completeRun(root, "S1", agent.id, agent.role, agent.id);
  }
  assert.equal(new Set(bindings.map(binding => binding.id)).size, 5);
  assert.equal(new Set(bindings.map(binding => binding.native_identifiers.thread_id)).size, 5);
  assert.equal((await records(root, "bindings")).length, 5);
  assert.equal((await records(root, "agents")).filter(value => value.schema === "dev.woia.agent-instance/v1").length, 5);
  await assertStoredReceipts(root, 7);
});

test("F: Project AGENTS creation and rebootstrap preserve unrelated and nested instructions without overrides", async t => {
  for (const existing of [false, true]) {
    await t.test(existing ? "existing Project AGENTS" : "absent Project AGENTS", async t => {
      const root = await temporaryProject(t);
      const agentsPath = path.join(root, "AGENTS.md");
      const nestedPath = path.join(root, "src", "nested", "AGENTS.md");
      const original = "# Project-owned instructions\n\nKeep these Project rules.\n";
      const nested = "# Nested team instructions\r\nPreserve these bytes exactly.\r\n";
      await mkdir(path.dirname(nestedPath), { recursive: true });
      await writeFile(nestedPath, nested);
      if (existing) await writeFile(agentsPath, original);
      const args = { root, projectId: "project-agents", department: "marketing", orchestrator: "woia-marketing", organizationRef: null };
      const first = await bootstrapProject(args);
      assert.equal(first.result, "CREATED");
      valid("project-state", first.state);
      assert.equal(first.state.root_agent_binding.instructions_file, "AGENTS.md");
      const created = await readFile(agentsPath, "utf8");
      if (existing) assert.ok(created.startsWith(original.trimEnd()));
      assert.equal(created.split(BEGIN).length - 1, 1);
      assert.equal(created.split(END).length - 1, 1);
      const suffix = "\n# Project-owned tail\nPreserve rules after the managed block.\n";
      await writeFile(agentsPath, created + suffix);
      const second = await bootstrapProject(args);
      assert.equal(second.result, "RECONCILED");
      const reconciled = await readFile(agentsPath, "utf8");
      assert.equal(reconciled, created + suffix);
      const blockStart = reconciled.indexOf(BEGIN);
      const blockEnd = reconciled.indexOf(END) + END.length;
      const stale = reconciled.slice(0, blockStart) + `${BEGIN}\nObsolete managed instructions.\n${END}` + reconciled.slice(blockEnd);
      await writeFile(agentsPath, stale);
      await bootstrapProject(args);
      assert.equal(await readFile(agentsPath, "utf8"), reconciled);
      assert.equal(reconciled.split(BEGIN).length - 1, 1);
      assert.equal(reconciled.split(END).length - 1, 1);
      assert.equal(await readFile(nestedPath, "utf8"), nested);
      await assert.rejects(() => access(path.join(root, "AGENTS.override.md")), { code: "ENOENT" });
      const projectFiles = await readdir(root, { recursive: true });
      assert.equal(projectFiles.some(file => path.basename(file) === "AGENTS.override.md"), false);
      assert.deepEqual(projectFiles.filter(file => path.basename(file) === "AGENTS.md").sort(), ["AGENTS.md", path.join("src", "nested", "AGENTS.md")].sort());
    });
  }
});

test("compatible Core patch reconciliation preserves Project state and requires a fresh loaded generation", async t => {
  const { root, task } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const binding = await activate(root, "S1", "agent-a", "thread-before-update");
  await completeRun(root, "S1", "agent-a");
  const project = await json(projectPath(root));
  const currentVersion = project.core_version;
  project.core_version = currentVersion === "0.5.0" ? "0.5.1" : "0.5.0";
  valid("project-state", project);
  await writeJson(projectPath(root), project);
  const args = { root, projectId: project.project.id, department: project.project.department, orchestrator: project.project.orchestrator, organizationRef: null };
  const migrated = await bootstrapProject(args);
  assert.equal(migrated.result, "RECONCILED");
  valid("project-state", migrated.state);
  assert.equal(migrated.state.core_version, currentVersion);
  assert.deepEqual(migrated.state.project, project.project);
  assert.deepEqual(migrated.state.provider_resolution, project.provider_resolution);
  assert.deepEqual(migrated.state.storage, project.storage);
  assert.equal(migrated.state.custom_agents.materialized_generation, GENERATION + 1);
  assert.equal(migrated.state.custom_agents.loaded_generation, GENERATION);
  assert.equal(migrated.state.custom_agents.status, "materialized_pending_reload");
  assert.equal(migrated.state.orchestration.runtime_restart_required, true);
  assert.equal(migrated.state.orchestration.current_task_id, task.id);
  assert.deepEqual(await record(root, "tasks", task.id), task);
  const repeated = await bootstrapProject(args);
  assert.deepEqual(repeated.state.custom_agents, migrated.state.custom_agents);
  assert.deepEqual(repeated.state.orchestration, migrated.state.orchestration);
  const blocked = await delegation(root, "S1", "agent-a");
  assert.equal(blocked.action, "BLOCKED");
  assert.equal(blocked.fresh_root_session_required, true);
  valid("checkpoint", blocked.checkpoint);
  assert.equal((await records(root, "bindings")).length, 1);
  assert.equal((await record(root, "bindings", binding.id)).native_identifiers.thread_id, "thread-before-update");
  assert.equal((await records(root, "runtime/runs")).length, 1);
});

test("Project identity conflicts and duplicate managed blocks fail without overwriting instructions", async t => {
  const root = await temporaryProject(t);
  const args = { root, projectId: "project-preserve", department: "marketing", orchestrator: "woia-marketing", organizationRef: null };
  await bootstrapProject(args);
  const agentsPath = path.join(root, "AGENTS.md");
  const initial = await readFile(agentsPath, "utf8");
  const projectBefore = await readFile(projectPath(root), "utf8");
  await assert.rejects(() => bootstrapProject({ ...args, department: "sales" }));
  assert.equal(await readFile(agentsPath, "utf8"), initial);
  assert.equal(await readFile(projectPath(root), "utf8"), projectBefore);
  const duplicated = `# Preserve all existing instructions\n\n${initial}\n${initial}`;
  await writeFile(agentsPath, duplicated);
  await assert.rejects(() => bootstrapProject(args));
  assert.equal(await readFile(agentsPath, "utf8"), duplicated);
  assert.equal(await readFile(projectPath(root), "utf8"), projectBefore);
});

test("an interrupted binding write checkpoints its reserved singleton through prepare or failThread", async t => {
  for (const recovery of ["prepare", "failThread"]) {
    await t.test(recovery, async t => {
      const { root, task } = await fixture(t);
      await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
      const interrupted = await faultOperation(root, "prepareDelegation", { sessionId: "S1", agentId: "agent-a", harness: HARNESS, threadStatus: "usable" }, { kind: "write-eio", target: ["bindings"] });
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.error.code, "EIO");
      assert.equal(interrupted.hits, 1);
      const sessionBefore = await json(path.join(root, ".woia", "runtime", "current-session.json"));
      assert.equal(typeof sessionBefore.bindings["agent-a"], "string");
      assert.equal((await records(root, "bindings")).length, 0);
      const blocked = recovery === "prepare"
        ? await delegation(root, "S1", "agent-a")
        : await failThread({ root, sessionId: "S1", agentId: "agent-a", reason: "Interrupted reservation write" });
      assert.equal(blocked.action, "BLOCKED");
      assert.equal(blocked.fresh_root_session_required, true);
      valid("checkpoint", blocked.checkpoint);
      const blockedTask = await record(root, "tasks", task.id);
      valid("task", blockedTask);
      assert.equal(blockedTask.state, "blocked");
      assert.deepEqual(blockedTask.current_checkpoint_ref, ref("Checkpoint", blocked.checkpoint.id));
      assert.deepEqual(blockedTask.blockers.map(value => value.id), [blocked.blocker.id]);
      for (const retry of [
        () => delegation(root, "S1", "agent-a"),
        () => failThread({ root, sessionId: "S1", agentId: "agent-a", reason: "Retry interrupted reservation recovery" }),
      ]) {
        const repeated = await retry();
        assert.equal(repeated.action, "BLOCKED");
        assert.equal(repeated.checkpoint.id, blocked.checkpoint.id);
        assert.equal(repeated.blocker.id, blocked.blocker.id);
      }
      const sessionAfter = await json(path.join(root, ".woia", "runtime", "current-session.json"));
      assert.deepEqual(sessionAfter.bindings, sessionBefore.bindings);
      assert.equal((await records(root, "checkpoints")).length, 1);
      assert.equal((await records(root, "bindings")).length, 0);
      assert.equal((await records(root, "runtime/runs")).length, 0);
      assert.deepEqual(await record(root, "tasks", task.id), blockedTask);
    });
  }
});

test("a failed checkpoint write resumes the same durable blocker and checkpoint without duplicate identities", async t => {
  const { root, task } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const binding = await activate(root, "S1", "agent-a", "thread-checkpoint-failure");
  const interrupted = await faultOperation(root, "failThread", { sessionId: "S1", agentId: "agent-a", reason: "Synthetic thread lost" }, { kind: "write-eio", target: ["checkpoints"] });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, "EIO");
  assert.equal(interrupted.hits, 1);
  const interruptedSession = await json(path.join(root, ".woia", "runtime", "current-session.json"));
  const failure = interruptedSession.failed_agents["agent-a"];
  assert.equal(typeof failure.checkpoint_id, "string");
  assert.equal(typeof failure.blocker_id, "string");
  assert.equal((await records(root, "checkpoints")).length, 0);
  assert.deepEqual((await record(root, "tasks", task.id)).blockers, []);
  const recovered = await delegation(root, "S1", "agent-a");
  assert.equal(recovered.action, "BLOCKED");
  assert.equal(recovered.checkpoint.id, failure.checkpoint_id);
  assert.equal(recovered.blocker.id, failure.blocker_id);
  valid("checkpoint", recovered.checkpoint);
  const recoveredTask = await record(root, "tasks", task.id);
  valid("task", recoveredTask);
  assert.equal(recoveredTask.state, "blocked");
  assert.deepEqual(recoveredTask.blockers.map(value => value.id), [failure.blocker_id]);
  assert.deepEqual(recoveredTask.current_checkpoint_ref, ref("Checkpoint", failure.checkpoint_id));
  for (let retry = 0; retry < 2; retry++) {
    const repeated = await delegation(root, "S1", "agent-a");
    assert.equal(repeated.action, "BLOCKED");
    assert.equal(repeated.checkpoint.id, failure.checkpoint_id);
    assert.equal(repeated.blocker.id, failure.blocker_id);
  }
  assert.equal((await records(root, "checkpoints")).length, 1);
  assert.deepEqual(await record(root, "tasks", task.id), recoveredTask);
  const bindings = await records(root, "bindings");
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, binding.id);
  assert.equal(bindings[0].state, "failed");
  assert.equal(bindings[0].native_identifiers.thread_id, "thread-checkpoint-failure");
});

test("explicit dead-owner lock recovery repairs continuation in a new session and refuses live or inaccessible owners", async t => {
  const { root, task } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  const binding = await activate(root, "S1", "agent-a", "thread-interrupted-owner");
  const run = await delegation(root, "S1", "agent-a");
  assert.equal(run.action, "DELEGATE");
  const ownerFile = path.join(root, ".woia", "runtime", "lifecycle.lock", "owner.json");
  const noticeFile = path.join(root, ".woia", "runtime", "recovery.json");
  const held = await holdOperation(root, "failThread", { sessionId: "S1", agentId: "agent-a", reason: "Interrupted failure checkpoint" }, { target: ["checkpoints"] });
  let failure;
  try {
    const owner = await json(ownerFile);
    assert.equal(owner.pid, held.pid);
    assert.equal(owner.hostname, os.hostname());
    assert.equal(typeof owner.token, "string");
    failure = (await json(path.join(root, ".woia", "runtime", "current-session.json"))).failed_agents["agent-a"];
    await assert.rejects(() => recoverAbandonedLock({ root, sessionId: "S2" }));
    assert.deepEqual(await json(ownerFile), owner);
    await assert.rejects(() => access(noticeFile), { code: "ENOENT" });
    const inaccessible = await faultOperation(root, "recoverAbandonedLock", { sessionId: "S2" }, { kind: "kill-eperm", pid: held.pid });
    assert.equal(inaccessible.ok, false);
    assert.equal(inaccessible.hits, 1, "The inaccessible-owner branch must actually be exercised");
    assert.deepEqual(await json(ownerFile), owner);
    await assert.rejects(() => access(noticeFile), { code: "ENOENT" });
  } finally { await held.stop(); }
  await assert.rejects(() => delegation(root, "S1", "agent-a"));
  await assert.rejects(() => recoverAbandonedLock({ root, sessionId: "S1" }));
  const recovered = await recoverAbandonedLock({ root, sessionId: "S2" });
  assert.equal(recovered.action, "LOCK_RECOVERED");
  assert.equal(recovered.fresh_root_session_required, true);
  assert.equal(recovered.session_id, "S2");
  await assert.rejects(() => access(ownerFile), { code: "ENOENT" });
  for (const oldOperation of [
    () => startSession({ root, sessionId: "S1", loadedGeneration: GENERATION }),
    () => closeSession({ root, sessionId: "S1" }),
    () => delegation(root, "S1", "agent-a"),
    () => bindThread({ root, sessionId: "S1", agentId: "agent-a", bindingId: binding.id, threadId: "thread-duplicate" }),
    () => failThread({ root, sessionId: "S1", agentId: "agent-a", reason: "Old-session retry" }),
    () => recordReceipt({ root, receipt: receiptFor(run) }),
  ]) await assert.rejects(oldOperation);
  await assert.rejects(() => startSession({ root, sessionId: "S3", loadedGeneration: GENERATION }));
  assert.equal((await records(root, "receipts")).length, 0);
  assert.equal((await startSession({ root, sessionId: "S2", loadedGeneration: GENERATION })).action, "SESSION_STARTED");
  await assert.rejects(() => access(noticeFile), { code: "ENOENT" });
  const checkpoint = await record(root, "checkpoints", failure.checkpoint_id);
  valid("checkpoint", checkpoint);
  const recoveredTask = await record(root, "tasks", task.id);
  valid("task", recoveredTask);
  assert.equal(recoveredTask.state, "blocked");
  assert.deepEqual(recoveredTask.current_checkpoint_ref, ref("Checkpoint", failure.checkpoint_id));
  assert.deepEqual(recoveredTask.blockers.map(value => value.id), [failure.blocker_id]);
  assert.equal((await record(root, "runtime/sessions", "S1")).state, "closed");
  assert.equal((await record(root, "agents", "agent-a")).active_binding_ref, null);
  assert.equal((await records(root, "checkpoints")).length, 1);
  assert.equal((await records(root, "bindings")).length, 1);
  assert.equal((await records(root, "runtime/runs")).length, 1);
  assert.equal((await delegation(root, "S2", "agent-a")).action, "WAIT_FOR_TASK");
  await assert.rejects(() => delegation(root, "S1", "agent-a"));
});

test("an interrupted recovery process does not leave an unrecoverable recovery mutex", async t => {
  const { root, task } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  await activate(root, "S1", "agent-a", "thread-recovery-crash");
  const firstOwner = await holdOperation(root, "failThread", { sessionId: "S1", agentId: "agent-a", reason: "Interrupted original owner" }, { target: ["checkpoints"] });
  await firstOwner.stop();
  const recoveryOwner = await holdOperation(root, "recoverAbandonedLock", { sessionId: "S2" }, { target: ["runtime", "recovery.json"], prefix: true });
  const recoveryOwnerFile = path.join(root, ".woia", "runtime", "recovery.lock", "owner.json");
  try {
    assert.equal((await json(recoveryOwnerFile)).pid, recoveryOwner.pid);
    await assert.rejects(() => recoverAbandonedLock({ root, sessionId: "S2" }));
    assert.equal((await json(recoveryOwnerFile)).pid, recoveryOwner.pid);
  } finally { await recoveryOwner.stop(); }
  assert.equal((await recoverAbandonedLock({ root, sessionId: "S2" })).action, "LOCK_RECOVERED");
  await assert.rejects(() => access(recoveryOwnerFile), { code: "ENOENT" });
  await startSession({ root, sessionId: "S2", loadedGeneration: GENERATION });
  const recoveredTask = await record(root, "tasks", task.id);
  assert.equal(recoveredTask.state, "blocked");
  assert.equal(recoveredTask.blockers.length, 1);
  const checkpoints = await records(root, "checkpoints");
  assert.equal(checkpoints.length, 1);
  valid("checkpoint", checkpoints[0]);
  assert.equal((await records(root, "bindings")).length, 1);
});

test("an Executor run cannot be completed by an Auditor receipt and freezes its issued role", async t => {
  const { root } = await fixture(t);
  await startSession({ root, sessionId: "S1", loadedGeneration: GENERATION });
  await activate(root, "S1", "agent-a", "thread-role");
  const result = await delegation(root, "S1", "agent-a");
  assert.equal(result.action, "DELEGATE");
  assert.equal(result.run.role, "executor");
  const changedAgent = await record(root, "agents", "agent-a");
  changedAgent.role = "auditor";
  changedAgent.revision++;
  valid("agent-instance", changedAgent);
  await writeJson(path.join(root, ".woia", "agents", "agent-a.json"), changedAgent);
  const wrongRole = receiptFor(result, "auditor", "audit");
  await assert.rejects(() => recordReceipt({ root, receipt: wrongRole }));
  assert.equal((await records(root, "receipts")).length, 0);
  const persistedRun = await record(root, "runtime/runs", result.run.id);
  assert.equal(persistedRun.role, "executor");
  assert.equal(persistedRun.state, "running");
  await recordReceipt({ root, receipt: receiptFor(result, "executor") });
  const next = await completeRun(root, "S1", "agent-a", "auditor");
  assert.equal(next.run.role, "auditor");
  assert.equal(next.run.thread_id, result.run.thread_id);
  await assertStoredReceipts(root, 2);
});
