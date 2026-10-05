import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findEffectGrant, requireEffectGrant } from "../skills/project-runtime/scripts/authority-guard.mjs";

const taskRef={ type: "Task", id: "task-1" };

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
  assert.equal(findEffectGrant(context([grant], { task_ref: { type: "Task", id: "other-task" } }), request), null);
  assert.equal(findEffectGrant(context([grant], { denials: ["unreconciled policy denial"] }), request), null);
});
