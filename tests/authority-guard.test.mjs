import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findEffectGrant, requireEffectGrant, requireLocalWrite } from "../skills/project-runtime/scripts/authority-guard.mjs";
import { bootstrapProject } from "../skills/project-runtime/scripts/bootstrap-project.mjs";

const taskRef={ kind: "Task", id: "task-1", revision: 1 };

function context(grants = [], overrides = {}) {
  return {
    schema: "dev.woia.authority-context/v1",
    id: "authority-business-rules",
    revision: 1,
    principal: { kind: "agent-instance", id: "agent-business-rules" },
    department: "software",
    task_ref: taskRef,
    grants,
    denials: [],
    ...overrides,
  };
}

const request = {
  principalId: "agent-business-rules",
  department: "software",
  taskRef,
  capability: "business-rules",
  operation: "persist-artifact",
  effectClass: "local-write",
};

test("local-write is denied when no matching Business Rules grant exists", () => {
  assert.equal(findEffectGrant(context(), request), null);
  assert.throws(() => requireEffectGrant(context(), request), (error) => error.code === "AUTHORITY_GRANT_REQUIRED");
  for (const grant of [
    { capability: "requirements", operations: ["persist-artifact"], effect_classes: ["local-write"] },
    { capability: "business-rules", operations: ["read-artifact"], effect_classes: ["local-write"] },
    { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["read"] },
  ]) {
    assert.equal(findEffectGrant(context([grant]), request), null);
  }
});

test("matching Business Rules local-write grant authorizes the persistence operation", () => {
  const grant = { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["read", "local-write"] };
  assert.equal(requireEffectGrant(context([grant]), request), grant);
});

test("authority guard executes before mutation: denied request writes zero bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woia-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "docs", "project", "02-BUSINESS-RULES.md");

  async function persist(authorityContext, body) {
    requireEffectGrant(authorityContext, request);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
    await writeFile(target, body, "utf8");
  }

  await assert.rejects(() => persist(context(), "# must not persist\n"), (error) => error.code === "AUTHORITY_GRANT_REQUIRED");
  await assert.rejects(stat(target), { code: "ENOENT" });

  const grant = { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["local-write"] };
  await persist(context([grant]), "# authorized\n");
  assert.equal(await readFile(target, "utf8"), "# authorized\n");
});

test("grant guard is minimum authority proof and does not infer a grant from technical access", () => {
  assert.equal(findEffectGrant(null, request), null);
  assert.equal(findEffectGrant({ schema: "dev.woia.authority-context/v1", grants: [] }, request), null);
});

test("principal task department and unresolved denials fail closed", () => {
  const grant = { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["local-write"] };
  assert.equal(findEffectGrant(context([grant], { principal: { kind: "agent-instance", id: "other-agent" } }), request), null);
  assert.equal(findEffectGrant(context([grant], { department: "marketing" }), request), null);
  assert.equal(findEffectGrant(context([grant], { task_ref: { kind: "Task", id: "other-task", revision: 1 } }), request), null);
  assert.equal(findEffectGrant(context([grant], { denials: ["unreconciled policy denial"] }), request), null);
});

test("Task identity and revision cannot be omitted or confused with a resource type", () => {
  const grant = { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["local-write"] };
  for (const taskRef of [undefined, {}, { type: "Task", id: "task-1", revision: 1 },
    { kind: "Project", id: "task-1", revision: 1 }, { kind: "Task", id: "task-1" },
    { kind: "Task", id: "task-1", revision: 2 }]) {
    assert.equal(findEffectGrant(context([grant]), { ...request, taskRef }), null);
  }
});

async function fixture(t, grants = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "woia-authority-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = "docs/project/02-BUSINESS-RULES.md";
  const resourceRef = { type: "artifact", id: "business-rules-artifact", uri: target };
  const input = { ...request, projectId: "project-1", agentRef: { kind: "AgentInstance", id: request.principalId, revision: 1 }, target, resourceRef };
  const records = {
    ".woia/project.json": { schema: "dev.woia.core-project-state/v1", project: { id: "project-1", department: "software" } },
    ".woia/tasks/task-1.json": { schema: "dev.woia.task/v1", id: "task-1", revision: 1, state: "active", department: "software", blockers: [], expected_outputs: [target] },
    ".woia/agents/agent.json": { schema: "dev.woia.agent-instance/v1", id: request.principalId, revision: 1, lifecycle: "active", task_ref: taskRef,
      authority_context_ref: { kind: "AuthorityContext", id: "authority-business-rules", revision: 1 }, resource_scope: [resourceRef] },
    ".woia/authority-contexts/authority.json": context(grants),
  };
  const save = async (file, value) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(value));
  };
  for (const [file, value] of Object.entries(records)) await save(file, value);
  return { root, input, records, save, target: path.join(root, target) };
}

const grant = { capability: "business-rules", operations: ["persist-artifact"], effect_classes: ["local-write"] };
const cli = path.resolve(import.meta.dirname, "../skills/project-runtime/scripts/authority-guard.mjs");

test("portable CLI checks durable scope before a consumer writes; denial preserves absence and bytes", async (t) => {
  const f = await fixture(t);
  const requestFile = path.join(f.root, "request.json");
  await writeFile(requestFile, JSON.stringify(f.input));
  const run = () => spawnSync(process.execPath, [cli, "--project-root", f.root, "--request", requestFile], { encoding: "utf8" });
  async function consumer(body) {
    const result = run();
    if (result.status !== 0) return result;
    const eligibility = JSON.parse(result.stdout);
    assert.equal(eligibility.allowed, true);
    await mkdir(path.dirname(eligibility.targetPath), { recursive: true });
    await writeFile(eligibility.targetPath, body);
    return result;
  }
  const negative = await consumer("unauthorized");
  assert.equal(negative.status, 1);
  assert.equal(JSON.parse(negative.stderr).code, "AUTHORITY_GRANT_REQUIRED");
  await assert.rejects(stat(f.target), { code: "ENOENT" });
  await mkdir(path.dirname(f.target), { recursive: true });
  const original = Buffer.from([0, 255, 13, 10, 42]);
  await writeFile(f.target, original);
  await consumer("unauthorized modification");
  assert.deepEqual(await readFile(f.target), original);
  await f.save(".woia/authority-contexts/authority.json", context([grant]));
  assert.equal(run().status, 0);
  assert.deepEqual(await readFile(f.target), original, "guard itself writes zero bytes");
  assert.equal((await consumer("authorized")).status, 0);
  assert.equal(await readFile(f.target, "utf8"), "authorized");
});

test("durable Project Task principal authority revision and resource mismatches deny", async (t) => {
  const f = await fixture(t, [grant]);
  assert.equal((await requireLocalWrite(f.root, f.input)).allowed, true);
  for (const update of [{ projectId: "other" }, { principalId: "other" }, { department: "marketing" },
    { taskRef: undefined }, { taskRef: { ...taskRef, revision: 2 } },
    { agentRef: { ...f.input.agentRef, revision: 2 } },
    { resourceRef: { ...f.input.resourceRef, id: "other" } },
    { target: "docs/project/other.md", resourceRef: { ...f.input.resourceRef, uri: "docs/project/other.md" } }]) {
    await assert.rejects(requireLocalWrite(f.root, { ...f.input, ...update }));
  }
  for (const [file, update] of [
    [".woia/tasks/task-1.json", { expected_outputs: [] }],
    [".woia/tasks/task-1.json", { state: "completed" }],
    [".woia/agents/agent.json", { resource_scope: [] }],
    [".woia/agents/agent.json", { authority_context_ref: { kind: "AuthorityContext", id: "authority-business-rules", revision: 2 } }],
    [".woia/authority-contexts/authority.json", { task_ref: { ...taskRef, revision: 2 } }],
    [".woia/authority-contexts/authority.json", { denials: ["opaque denial"] }],
  ]) {
    await f.save(file, { ...f.records[file], ...update });
    await assert.rejects(requireLocalWrite(f.root, f.input));
    await f.save(file, f.records[file]);
  }
});

test("local target traversal absolute paths and symlink ancestors deny even if listed in scope", async (t) => {
  const f = await fixture(t, [grant]);
  for (const target of ["../outside.md", "/outside.md", "C:/outside.md", "docs/../outside.md", "docs\\outside.md", "docs//outside.md", "docs./outside.md", "docs /outside.md", "docs/con.md", "docs/name:stream"]) {
    await assert.rejects(requireLocalWrite(f.root, { ...f.input, target, resourceRef: { ...f.input.resourceRef, uri: target } }));
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), "woia-authority-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(f.root, "docs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(requireLocalWrite(f.root, f.input), { code: "AUTHORITY_SCOPE_REQUIRED" });
});

test("authority CLI without arguments fails closed instead of succeeding as a no-op", () => {
  assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 1);
});

test("Project bootstrap installs the executable local-write guard operating contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woia-authority-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await bootstrapProject({ root, projectId: "guard-contract", department: "software", orchestrator: "woia-software" });
  const instructions = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(instructions, /authority-guard\.mjs with --project-root and --request/);
  assert.match(instructions, /Require successful exit and allowed: true/);
  assert.match(instructions, /A denial permits zero mutation/);
  assert.match(instructions, /never broaden a grant or resource_scope/);
});
