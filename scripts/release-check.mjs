import { execFileSync, spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  assert,
  readJson,
  scanPortablePayload,
  validateManifest,
  validateMarkdownLinks,
  validateMcp,
  validateNoTemplatePlaceholders,
  validateRootSafety,
  validateSkills,
} from "./lib/plugin.mjs";
import { validatePortableArchive } from "./lib/archive.mjs";

function gitOutput(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Git ${args.join(" ")} failed: ${detail}`);
  }
}

function assertCleanTree(root) {
  let status;
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`release:check requires an initialized Git repository: ${error.message}`);
  }
  assert(status.trim() === "", "release:check requires a clean Git working tree, including untracked files");
}

function runCandidateTests(root, { quiet = false } = {}) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (!quiet && result.stderr) process.stderr.write(result.stderr);
  assert(result.status === 0, `release:check failed because the discovered test suite exited with ${result.status ?? "unknown"}`);
}

async function validateReleaseVersion(root, manifest) {
  const packageJson = await readJson(path.join(root, "package.json"));
  assert(packageJson.version === manifest.version,
    `package.json version ${packageJson.version} must match plugin.json version ${manifest.version}`);
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version),
    `plugin.json version must be a SemVer version: ${manifest.version}`);

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const latestHeading = changelog.match(/^##\s+(\S+)/m)?.[1];
  assert(latestHeading === manifest.version,
    `The first CHANGELOG.md release heading must match plugin.json version ${manifest.version}`);
}

export async function runReleaseCheck(root = ROOT, { quiet = false } = {}) {
  const isWorkTree = gitOutput(root, ["rev-parse", "--is-inside-work-tree"]);
  assert(isWorkTree === "true", "release:check requires a valid Git worktree");
  const repositoryRoot = await realpath(gitOutput(root, ["rev-parse", "--show-toplevel"]));
  assert(repositoryRoot === await realpath(root), "release:check must run from the plugin repository root");
  const candidate = gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  assert(/^[0-9a-f]{40,64}$/i.test(candidate), "release:check requires a resolved candidate commit SHA");
  assertCleanTree(root);

  try {
    execFileSync("git", ["diff-tree", "--check", "--root", "--no-commit-id", "-r", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr]
      .map((output) => output?.toString().trim())
      .filter(Boolean)
      .join("\n") || error.message;
    throw new Error(`Candidate ${candidate} has whitespace errors: ${detail}`);
  }

  const manifest = await validateManifest(root);
  await validateMcp(root);
  await validateNoTemplatePlaceholders(root);
  await validateSkills(root);
  await validateMarkdownLinks(root);
  await validateRootSafety(root);
  await scanPortablePayload(root);
  await validateReleaseVersion(root, manifest);

  runCandidateTests(root, { quiet });
  const archiveFiles = await validatePortableArchive(root, "HEAD");
  assertCleanTree(root);
  const currentHead = gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  assert(currentHead === candidate, "HEAD changed while release:check was validating the candidate");

  if (!quiet) {
    console.log(`release:check: ${manifest.name}@${manifest.version} candidate ${candidate}`);
    console.log(`release:check: manifest, MCP, template placeholders, skills, links, paths, secrets, tests, version, whitespace, and ${archiveFiles}-file portable archive OK`);
  }
  return { candidate, version: manifest.version, archiveFiles };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) await runReleaseCheck();
