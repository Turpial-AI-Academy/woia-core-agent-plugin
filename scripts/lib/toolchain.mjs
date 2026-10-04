import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { ROOT as REPO_ROOT, canonicalToolchain, assertRuntimeVersions } from "./toolchain-contract.mjs";

const ROOT = REPO_ROOT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function validateToolchainDeclarations(root = ROOT) {
  const expected = await canonicalToolchain(root);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const mise = parseToml(await readFile(path.join(root, "mise.toml"), "utf8"));
  const miseLock = parseToml(await readFile(path.join(root, "mise.lock"), "utf8"));
  const pnpmWorkspace = parseDocument(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"), {
    schema: "core",
    stringKeys: true,
    uniqueKeys: true,
    logLevel: "error",
  });
  assert(pnpmWorkspace.errors.length === 0,
    "pnpm-workspace.yaml has invalid YAML: " + pnpmWorkspace.errors.map((error) => error.message).join("; "));
  const pnpmWorkspaceSettings = pnpmWorkspace.toJS();

  assert(packageJson.engines.pnpm === expected.pnpm,
    `package.json engines.pnpm must exactly match packageManager ${expected.pnpm}`);
  assert(mise.tools?.node === expected.node, `mise.toml must use Node ${expected.node} from package.json`);
  assert(mise.tools?.pnpm === expected.pnpm, `mise.toml must use pnpm ${expected.pnpm} from package.json`);
  assert(mise.settings?.auto_install === false, "mise.toml must not auto-install tools before gates");
  assert(mise.settings?.not_found_auto_install === false, "mise.toml must not auto-install missing command providers");
  assert(mise.settings?.task?.run_auto_install === false, "mise.toml task execution must not auto-install tools");
  assert(pnpmWorkspaceSettings?.verifyDepsBeforeRun === "error",
    "pnpm-workspace.yaml must set verifyDepsBeforeRun: error so pnpm run cannot install dependencies implicitly");
  assert(miseLock.tools?.node?.[0]?.version === expected.node,
    `mise.lock must lock Node ${expected.node} from package.json`);
  assert(miseLock.tools?.pnpm?.[0]?.version === expected.pnpm,
    `mise.lock must lock pnpm ${expected.pnpm} from package.json`);
  return expected;
}

export async function validateCurrentToolchain(root = ROOT) {
  const declared = await validateToolchainDeclarations(root);
  await assertRuntimeVersions(root);
  return declared;
}
