import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS = fileURLToPath(import.meta.url);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parse(argv) {
  let taskId = null;
  let capability = null;
  let plugin = null;
  let version = null;
  let selector = null;
  let output = null;
  let organizationRevision = null;
  let departmentRevision = null;
  const overlays = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${token}`);
    if (token === "--task-id") taskId = value;
    else if (token === "--capability") capability = value;
    else if (token === "--plugin") plugin = value;
    else if (token === "--version") version = value;
    else if (token === "--selector") selector = value;
    else if (token === "--overlay") overlays.push(path.resolve(value));
    else if (token === "--organization-revision") organizationRevision = Number(value);
    else if (token === "--department-revision") departmentRevision = Number(value);
    else if (token === "--output") output = path.resolve(value);
    else fail(`unknown argument: ${token}`);
  }

  if (!taskId || !capability || !plugin || !version || !selector || !output) {
    fail("--task-id, --capability, --plugin, --version, --selector and --output are required");
  }
  return { taskId, capability, plugin, version, selector, output, overlays, organizationRevision, departmentRevision };
}

async function readMaybe(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

function stableSnapshot(snapshot) {
  const { created_at: _createdAt, ...stable } = snapshot;
  return stable;
}

async function writeImmutableSnapshot(file, snapshot) {
  const existingRaw = await readMaybe(file);
  if (existingRaw !== null) {
    let existing;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      fail(`${file}: existing capability snapshot is not valid JSON`);
    }
    if (typeof existing.created_at !== "string") fail(`${file}: existing capability snapshot has no created_at`);
    if (canonical(stableSnapshot(existing)) !== canonical(stableSnapshot(snapshot))) {
      fail(`${file}: capability snapshots are immutable; output already contains a different snapshot`);
    }
    return { result: "UNCHANGED", snapshot: existing };
  }

  await atomicWrite(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { result: "CREATED", snapshot };
}

export async function createCapabilitySnapshot(args) {
  if (!SEMVER.test(args.version)) fail("base version must be stable SemVer");
  for (const [label, value] of [
    ["organization revision", args.organizationRevision],
    ["department revision", args.departmentRevision],
  ]) {
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      fail(`${label} must be a positive integer`);
    }
  }

  const order = { organization: 0, department: 1, project: 2 };
  const loaded = [];
  for (const file of args.overlays) {
    const doc = JSON.parse(await readFile(file, "utf8"));
    if (doc.schema !== "dev.woia.plugin-overlay/v1") fail(`${file}: unsupported overlay schema`);
    if (!(doc.scope in order)) fail(`${file}: invalid overlay scope`);
    if (doc.plugin !== args.plugin) fail(`${file}: overlay plugin does not match ${args.plugin}`);
    if (doc.compatibility?.status !== "compatible") fail(`${file}: overlay is not compatible with base ${args.version}`);
    if (doc.compatibility.last_validated_base !== args.version) fail(`${file}: overlay compatibility was validated for another base version`);
    loaded.push({ file, doc });
  }
  loaded.sort((a, b) => (order[a.doc.scope] - order[b.doc.scope]) || a.doc.id.localeCompare(b.doc.id) || a.doc.revision - b.doc.revision);

  const identity = {
    base: { plugin: args.plugin, version: args.version, selector: args.selector },
    overlays: loaded.map(({ doc }) => ({ id: doc.id, revision: doc.revision, scope: doc.scope })),
    organization_profile_revision: args.organizationRevision ?? null,
    department_profile_revision: args.departmentRevision ?? null,
  };
  const digest = `sha256:${createHash("sha256").update(canonical(identity)).digest("hex")}`;
  const short = digest.slice(7, 19);
  const snapshot = {
    schema: "dev.woia.effective-capability-snapshot/v1",
    id: `snapshot:${args.taskId}:${args.plugin}:${short}`,
    task_ref: { kind: "Task", id: args.taskId },
    capability: args.capability,
    base: identity.base,
    overlays: identity.overlays.map(({ id, revision }) => ({ id, revision })),
    organization_profile_revision: identity.organization_profile_revision,
    department_profile_revision: identity.department_profile_revision,
    composed_digest: digest,
    created_at: new Date().toISOString(),
  };

  const write = await writeImmutableSnapshot(args.output, snapshot);
  return { result: write.result, output: args.output, snapshot: write.snapshot, composition: identity };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS);
if (isMain) {
  try {
    console.log(JSON.stringify(await createCapabilitySnapshot(parse(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`woia:create-capability-snapshot: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
