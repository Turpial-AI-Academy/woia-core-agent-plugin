import Ajv2020 from "ajv/dist/2020.js";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, assert, readJson } from "./lib/plugin.mjs";

// Validate the installed contract graph without creating consumer Project state.
const manifest = await readJson(path.join(ROOT, "dev.woia/manifest.json"));
const plugin = await readJson(path.join(ROOT, "plugin.json"));
assert(manifest.version === plugin.version, "Core contract manifest version must match plugin version");
const schemaRoot = path.join(ROOT, "dev.woia/schemas");
const actual = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json")).sort();
const expected = manifest.schemas.map((name) => `${name}.schema.json`).sort();
assert(JSON.stringify(actual) === JSON.stringify(expected), "Core manifest must enumerate the complete schema graph");
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: {
  "date-time": (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
} });
const schemas = [];
for (const file of actual) {
  const schema = await readJson(path.join(schemaRoot, file));
  ajv.addSchema(schema);
  schemas.push(schema);
}
for (const schema of schemas) assert(ajv.getSchema(schema.$id), `Cannot compile Core schema ${schema.$id}`);
const profileSchema = schemas.find((schema) => schema.$id.endsWith("/workflow-profile.schema.json"));
assert(profileSchema, "Core must define the workflow-profile schema");
const validateProfile = ajv.getSchema(profileSchema.$id);
const profiles = (await readdir(path.join(ROOT, "dev.woia/workflow-profiles"))).filter((file) => file.endsWith(".json")).sort();
assert(JSON.stringify(profiles) === JSON.stringify(manifest.workflow_profiles.map((name) => `${name}.json`).sort()), "Core manifest must enumerate every workflow profile");
for (const file of profiles) {
  const profile = await readJson(path.join(ROOT, "dev.woia/workflow-profiles", file));
  assert(validateProfile(profile), `${file}: ${JSON.stringify(validateProfile.errors)}`);
  assert(profile.applies_to === "non-software", `${file}: Core workflow profiles must remain non-software`);
}
for (const tool of manifest.deterministic_tools) {
  assert(!path.isAbsolute(tool.path) && !tool.path.split(/[\\/]/).includes(".."), `Unsafe tool path ${tool.path}`);
  const result = spawnSync(process.execPath, ["--check", path.join(ROOT, tool.path)], { encoding: "utf8" });
  if (result.error) throw result.error;
  assert(result.status === 0, `${tool.id}: ${result.stderr || "Invalid deterministic tool"}`);
}
console.log(`contracts: ${schemas.length} schemas, ${profiles.length} profiles and ${manifest.deterministic_tools.length} deterministic tools validated`);
