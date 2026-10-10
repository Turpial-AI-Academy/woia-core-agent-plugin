import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(label + " is required", "INVALID_AUTHORITY_REQUEST");
  return value;
}

function sameRef(actual, expected) {
  if (!actual || !expected || actual.kind !== expected.kind || !expected.kind || !expected.id) return false;
  return actual.kind === expected.kind &&
    actual.id === expected.id &&
    (expected.revision === undefined || actual.revision === expected.revision);
}

export function findEffectGrant(authorityContext, request) {
  if (!authorityContext || authorityContext.schema !== "dev.woia.authority-context/v1") return null;
  if (typeof authorityContext.id !== "string" || !authorityContext.id ||
      !Number.isInteger(authorityContext.revision) || authorityContext.revision < 1) return null;

  const capability = assertString(request?.capability, "capability");
  const operation = assertString(request?.operation, "operation");
  const effectClass = assertString(request?.effectClass, "effectClass");
  const principalId = assertString(request?.principalId, "principalId");
  const department = assertString(request?.department, "department");

  if (request?.taskRef?.kind !== "Task" || !request.taskRef.id ||
      !Number.isInteger(request.taskRef.revision) || request.taskRef.revision < 1) return null;

  if (authorityContext.principal?.kind !== "agent-instance" || authorityContext.principal?.id !== principalId) return null;
  if (authorityContext.department !== department) return null;
  if (!sameRef(authorityContext.task_ref, request?.taskRef)) return null;

  // Denials are intentionally opaque strings in the v1 schema. Until they have a
  // structured matching contract, fail closed rather than guessing that a grant wins.
  if (!Array.isArray(authorityContext.denials) || authorityContext.denials.length > 0) return null;

  const grants = Array.isArray(authorityContext.grants) ? authorityContext.grants : [];
  return grants.find((grant) =>
    grant?.capability === capability &&
    Array.isArray(grant.operations) &&
    grant.operations.includes(operation) &&
    Array.isArray(grant.effect_classes) &&
    grant.effect_classes.includes(effectClass)
  ) ?? null;
}

export function requireEffectGrant(authorityContext, request) {
  const grant = findEffectGrant(authorityContext, request);
  if (!grant) {
    fail(
      "WOIA authority denied: no current exact grant for " +
        [request?.capability, request?.operation, request?.effectClass].join(" / "),
      "AUTHORITY_GRANT_REQUIRED",
    );
  }
  return grant;
}

function denied(message) {
  fail("WOIA authority denied: " + message, "AUTHORITY_SCOPE_REQUIRED");
}

// Local targets are exact Project-relative resources, never glob/directory grants.
function relativeTarget(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[<>:"|?*\x00-\x1f]/u.test(value) ||
      value.includes("\0") || path.posix.isAbsolute(value) ||
      value.split("/").some((part) => !part || /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) denied("invalid relative target");
  return value;
}

async function safePath(root, relative) {
  const parts = relativeTarget(relative).split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) denied("symlink/reparse target or ancestor");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}

async function record(root, directory, schema, ref, currentIdentity = false) {
  if (!ref || typeof ref.id !== "string" || !ref.id ||
      (!(currentIdentity && ref.revision === undefined) && (!Number.isInteger(ref.revision) || ref.revision < 1))) denied("missing durable reference revision");
  const folder = await safePath(root, ".woia/" + directory);
  const matches = [];
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".json")) continue;
    const file = await safePath(root, ".woia/" + directory + "/" + name);
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.schema === schema && value.id === ref.id) matches.push(value);
  }
  if (matches.length !== 1 || !Number.isInteger(matches[0].revision) || matches[0].revision < 1 ||
      (ref.revision !== undefined && matches[0].revision !== ref.revision)) denied("durable identity/revision mismatch: " + ref.id);
  return matches[0];
}

/** Read current Project-owned records before eligibility. Never writes any file. */
export async function requireLocalWrite(projectRoot, request) {
  const root = await realpath(assertString(projectRoot, "projectRoot"));
  if (request?.effectClass !== "local-write") denied("local-write required");
  const project = JSON.parse(await readFile(await safePath(root, ".woia/project.json"), "utf8"));
  if (project.schema !== "dev.woia.core-project-state/v1" ||
      project.project?.id !== assertString(request.projectId, "projectId") ||
      project.project?.department !== request.department) denied("Project identity/department mismatch");
  const generation = project.custom_agents?.materialized_generation;
  if (!Number.isSafeInteger(generation) || generation < 0 || project.custom_agents.loaded_generation !== generation
      || project.orchestration?.runtime_restart_required !== false) denied("current runtime generation is not loaded");
  if (request.taskRef?.kind !== "Task") denied("Task reference required");
  const task = await record(root, "tasks", "dev.woia.task/v1", request.taskRef);
  if (task.department !== request.department || task.state !== "active" ||
      !Array.isArray(task.blockers) || task.blockers.length) denied("Task is not eligible for execution");
  const agent = await record(root, "agents", "dev.woia.agent-instance/v1", request.agentRef);
  if (request.agentRef?.kind !== "AgentInstance" || agent.id !== request.principalId ||
      agent.lifecycle !== "active" || !sameRef(agent.task_ref, request.taskRef)) denied("AgentInstance/Task mismatch");
  const bindingRef = agent.active_binding_ref;
  if (bindingRef?.kind !== "HarnessRuntimeBinding") denied("AgentInstance has no current harness binding");
  const binding = await record(root, "bindings", "dev.woia.runtime-binding/v1", bindingRef, true);
  if (binding.state !== "active" || binding.materialized_generation !== generation || binding.loaded_generation !== generation
      || !sameRef(binding.task_ref, {kind: "Task", id: request.taskRef.id})
      || !sameRef(binding.agent_instance_ref, {kind: "AgentInstance", id: request.agentRef.id})) denied("runtime binding is stale or outside current scope");
  const session = JSON.parse(await readFile(await safePath(root, ".woia/runtime/current-session.json"), "utf8"));
  if (!binding.root_session_id || session.id !== binding.root_session_id || session.state !== "active"
      || session.loaded_generation !== generation) denied("runtime binding has no matching current root-session observation");
  const authorityRef = agent.authority_context_ref;
  if (authorityRef?.kind !== "AuthorityContext") denied("AgentInstance has no authority context");
  const authority = await record(root, "authority-contexts", "dev.woia.authority-context/v1", authorityRef);
  const grant = requireEffectGrant(authority, request);
  const target = relativeTarget(request.target);
  const resource = request.resourceRef;
  if (!resource || typeof resource.type !== "string" || !resource.type || typeof resource.id !== "string" || !resource.id ||
      resource.uri !== target || !Array.isArray(agent.resource_scope) ||
      !agent.resource_scope.some((item) => item.type === resource.type && item.id === resource.id &&
        item.uri === target && item.version === resource.version) ||
      !Array.isArray(task.expected_outputs) || !task.expected_outputs.includes(target)) denied("target is outside Task output/AgentInstance resource scope");
  const targetPath = await safePath(root, target);
  return { allowed: true, projectId: project.project.id, taskRef: request.taskRef,
    agentRef: request.agentRef, authorityContextRef: authorityRef, resourceRef: resource,
    capability: request.capability, operation: request.operation, effectClass: request.effectClass,
    target, targetPath, grant };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--project-root" || args[2] !== "--request") {
      fail("Usage: authority-guard.mjs --project-root <root> --request <request.json>", "INVALID_AUTHORITY_REQUEST");
    }
    const result = await requireLocalWrite(args[1], JSON.parse(await readFile(args[3], "utf8")));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ allowed: false, code: error.code ?? "AUTHORITY_INPUT_ERROR", message: error.message }));
    process.exitCode = 1;
  }
}
