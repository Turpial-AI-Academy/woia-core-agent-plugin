import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import {
  ROOT,
  AUTHORING_ROOT_DIRS,
  AUTHORING_ROOT_FILES,
  SCHEMA,
  SCHEMA_FILE,
  MCP_SCHEMA,
  MCP_SCHEMA_FILE,
  generateChecksums,
  parseFrontmatter,
  portablePayloadPaths,
  scanPortablePayload,
  validateChecksums,
  validateManifest,
  validateMarkdownLinks,
  validateMcp,
  validateNoTemplatePlaceholders,
  validateRootSafety,
  validateSkills,
} from "../scripts/lib/plugin.mjs";
import { validatePortableArchive } from "../scripts/lib/archive.mjs";
import { runReleaseCheck } from "../scripts/release-check.mjs";
import { validateToolchainDeclarations } from "../scripts/lib/toolchain.mjs";

const SCHEMA_SHA256 = "0A4AAD95CE337878AD38802EBF0DAA3FDE76ABE3F65400C86BCBB1EC0B3AB883";
const ATTRIBUTE_LINES = [
  "* text=auto eol=lf",
  "/.github/ export-ignore",
  "/scripts/ export-ignore",
  "/tests/ export-ignore",
  "/docs/ export-ignore",
  "/AGENTS.md export-ignore",
  "/CONTRIBUTING.md export-ignore",
  "/SECURITY.md export-ignore",
  "/README.plugin.md export-ignore",
  "/package.json export-ignore",
  "/pnpm-lock.yaml export-ignore",
  "/pnpm-workspace.yaml export-ignore",
  "/VALIDATION.md export-ignore",
  "/mise.toml export-ignore",
  "/mise.lock export-ignore",
  "/.editorconfig export-ignore",
  "/.gitignore export-ignore",
  "/.gitattributes export-ignore",
].join("\n") + "\n";

function validManifest(overrides = {}) {
  return {
    $schema: SCHEMA,
    name: "sample-plugin",
    version: "1.0.0",
    description: "A fixture Agent Plugin.",
    ...overrides,
  };
}

function validSkill(frontmatter = "") {
  return `---\nname: example\ndescription: Audits a sample repository. Use when checking CI.\n${frontmatter}---\n\nInstructions.\n`;
}

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });

  const manifest = options.manifest ?? validManifest();
  const version = options.packageVersion ?? manifest.version ?? "1.0.0";
  const files = new Map([
    ["plugin.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["README.md", options.readme ?? "# Fixture\n\n[Skill](skills/example/SKILL.md)\n"],
    ["CHANGELOG.md", `# Changelog\n\n## ${options.changelogVersion ?? version} - 2026-09-25\n\n- Fixture.\n`],
    ["LICENSE", "Fixture license\n"],
    ["CHECKSUMS.sha256", ""],
    ["skills/example/SKILL.md", options.skill ?? validSkill(options.frontmatter ?? "")],
    [".gitattributes", options.attributes ?? ATTRIBUTE_LINES],
    [".gitignore", "node_modules/\ntmp/\n*.log\n"],
    ["package.json", JSON.stringify(options.packageJson ?? { name: "fixture", version, private: true }, null, 2) + "\n"],
    ["pnpm-lock.yaml", options.pnpmLock ?? "lockfileVersion: '9.0'\n"],
    ["pnpm-workspace.yaml", options.pnpmWorkspace ?? "verifyDepsBeforeRun: error\n"],
    ["mise.toml", "[tools]\nnode = '24.21.0'\npnpm = '11.19.0'\n"],
    ["mise.lock", "lockfile_version = 2\n"],
    ...Object.entries(options.extraFiles ?? {}),
  ]);

  for (const [relativePath, content] of files) {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(content)) await writeFile(target, content);
    else await writeFile(target, content, "utf8");
  }
  await generateChecksums(root);
  return { root, files };
}

function commitFixture(root) {
  execFileSync("git", ["add", "--all"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture candidate"], {
    cwd: root,
    stdio: "ignore",
  });
}

test("the offline manifest schema is the versioned official Agent Plugins 1.0.0 schema", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_FILE, "utf8"));
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(await readFile(SCHEMA_FILE)).digest("hex").toUpperCase(), SCHEMA_SHA256);
  assert.equal(schema.$id, SCHEMA);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const manifest = await validateManifest(ROOT);
  assert.doesNotMatch(manifest.name, /__/);
  assert.doesNotMatch(manifest.version ?? "", /__/);
});

test("optional MCP configuration validates against the Agent Plugins 1.0.0 MCP schema", async (t) => {
  const schema = JSON.parse(await readFile(MCP_SCHEMA_FILE, "utf8"));
  assert.equal(schema.$id, MCP_SCHEMA);
  const valid = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          local: {
            type: "stdio",
            command: "./plugin-resources/bin/server.js",
            cwd: "${PLUGIN_ROOT}/plugin-resources"
          },
          remote: { type: "streamable-http", url: "https://example.invalid/mcp" }
        }
      }, null, 2) + "\n",
      "plugin-resources/bin/server.js": "console.log('fixture');\n",
    },
  });
  await assert.doesNotReject(() => validateMcp(valid.root));

  const invalidSchema = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: { example: { type: "stdio" } }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(invalidSchema.root), /MCP schema/);

  const insecureRemote = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: { example: { type: "streamable-http", url: "http://example.com/mcp" } }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(insecureRemote.root), /must use HTTPS/);

  const traversalCommand = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: { example: { type: "stdio", command: "../server" } }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(traversalCommand.root), /must begin with/);
});

test("manifest validation covers the complete schema, including closed author and root objects", async (t) => {
  const missingRequired = await createFixture(t, { manifest: { name: "sample-plugin" } });
  await assert.rejects(validateManifest(missingRequired.root), /official Agent Plugins 1\.0\.0 schema/);

  const unsupportedRoot = await createFixture(t, { manifest: validManifest({ customField: true }) });
  await assert.rejects(validateManifest(unsupportedRoot.root), /additional properties/);

  const unsupportedAuthor = await createFixture(t, { manifest: validManifest({ author: { name: "Fixture", handle: "x" } }) });
  await assert.rejects(validateManifest(unsupportedAuthor.root), /additional properties/);
});

test("Agent Skills frontmatter accepts current optional fields and nested metadata", async (t) => {
  const fixture = await createFixture(t, {
    frontmatter: [
      "license: MIT",
      "compatibility: Requires git and a POSIX-compatible shell.",
      "metadata:",
      "  author: Turpial AI Academy",
      '  version: "1.0"',
      "allowed-tools: Read Bash(git:*)",
    ].join("\n") + "\n",
  });
  const { data } = await parseFrontmatter(path.join(fixture.root, "skills/example/SKILL.md"), fixture.root);
  assert.equal(data.license, "MIT");
  assert.deepEqual(data.metadata, { author: "Turpial AI Academy", version: "1.0" });
  assert.deepEqual(await validateSkills(fixture.root), []);
});

test("invalid skill metadata and malformed YAML frontmatter fail", async (t) => {
  const invalidSkill = await createFixture(t, {
    skill: `---\nname: example\ndescription: ${"x".repeat(1025)}\n---\nBody.\n`,
  });
  await assert.rejects(validateSkills(invalidSkill.root), /at most 1024 characters/);

  const invalidYaml = await createFixture(t, {
    skill: "---\nname: example\nname: duplicate\ndescription: Invalid.\n---\nBody.\n",
  });
  await assert.rejects(validateSkills(invalidYaml.root), /invalid YAML frontmatter/);

  const invalidMetadata = await createFixture(t, {
    frontmatter: "metadata:\n  author: 123\n",
  });
  await assert.rejects(validateSkills(invalidMetadata.root), /metadata values must be strings/);
});

test("broken and traversing Markdown links fail", async (t) => {
  const broken = await createFixture(t, { readme: "# Fixture\n\n[Missing](missing.md)\n" });
  await assert.rejects(validateMarkdownLinks(broken.root), /missing/);

  const traversal = await createFixture(t, { readme: "# Fixture\n\n[Outside](..%2F..%2Foutside.md)\n" });
  await assert.rejects(validateMarkdownLinks(traversal.root), /escapes plugin root/);

  const portableLinkToMaintenance = await createFixture(t, {
    readme: "# Fixture\n\n[Maintenance](docs/maintenance.md)\n",
    extraFiles: { "docs/maintenance.md": "Repository-only details\n" },
  });
  await assert.rejects(validateMarkdownLinks(portableLinkToMaintenance.root), /not included in the portable payload/);

  const maintenanceSource = await createFixture(t, {
    extraFiles: { "docs/maintenance.md": "[Contributor guide](../CONTRIBUTING.md)\n", "CONTRIBUTING.md": "Local maintenance\n" },
  });
  await writeFile(path.join(maintenanceSource.root, "README.md"), "# Fixture\n", "utf8");
  await generateChecksums(maintenanceSource.root);
  await validateMarkdownLinks(maintenanceSource.root);
});

test("portable checksums ignore maintenance and ignored local files and detect payload changes", async (t) => {
  const fixture = await createFixture(t, {
    extraFiles: {
      "scripts/local-helper.mjs": "export {};\n",
      "docs/local-note.md": "ignored from release\n",
      "node_modules/local-only.txt": "not a release file\n",
    },
  });
  const before = await readFile(path.join(fixture.root, "CHECKSUMS.sha256"), "utf8");
  const payloadPaths = await portablePayloadPaths(fixture.root);
  assert.equal(payloadPaths.some((entry) => entry.startsWith("scripts/")), false);
  assert.equal(payloadPaths.some((entry) => entry.startsWith("docs/")), false);
  assert.equal(payloadPaths.includes("pnpm-workspace.yaml"), false);
  await validateChecksums(fixture.root);

  await writeFile(path.join(fixture.root, "LICENSE"), "changed license\n", "utf8");
  await assert.rejects(validateChecksums(fixture.root), /CHECKSUMS.sha256 mismatch/);
  await writeFile(path.join(fixture.root, "LICENSE"), "Fixture license\n", "utf8");
  assert.equal(await readFile(path.join(fixture.root, "CHECKSUMS.sha256"), "utf8"), before);
});

test("checksum generation bootstraps a missing CHECKSUMS.sha256 file", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.root, "CHECKSUMS.sha256"));
  await assert.rejects(access(path.join(fixture.root, "CHECKSUMS.sha256")), { code: "ENOENT" });

  const count = await generateChecksums(fixture.root);
  assert.ok(count > 0);
  await access(path.join(fixture.root, "CHECKSUMS.sha256"));
  await validateChecksums(fixture.root);
});

test("portable release validation does not require a source checksum manifest", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.root, "CHECKSUMS.sha256"));
  commitFixture(fixture.root);
  await assert.doesNotReject(() => validatePortableArchive(fixture.root, "HEAD"));
});

test("portable path safety and secret-like material are rejected", async (t) => {
  const pathFixture = await createFixture(t);
  const target = path.join(pathFixture.root, "skills/example/SKILL.md");
  await rm(target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, validSkill(), "utf8");
  await validateRootSafety(pathFixture.root);

  const secretFixture = await createFixture(t, {
    readme: "# Fixture\n\nSynthetic test value: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD\n",
  });
  await assert.rejects(scanPortablePayload(secretFixture.root), /GitHub token-like value/);

  const pathSeparator = String.fromCharCode(92);
  const windowsUserPath = ["C:", "Users", "sample", "private.txt"].join(pathSeparator);
  const userPathFixture = await createFixture(t, {
    readme: `# Fixture\n\n${windowsUserPath}\n`,
  });
  await assert.rejects(scanPortablePayload(userPathFixture.root), /absolute Windows user path/);

  const escapedWindowsUserPath = ["C:", "Users", "sample", "private.txt"].join(pathSeparator.repeat(2));
  const escapedPathFixture = await createFixture(t, {
    readme: "# Fixture\n\n" + escapedWindowsUserPath + "\n",
  });
  await assert.rejects(scanPortablePayload(escapedPathFixture.root), /escaped absolute Windows user path/);
});

test("portable scanning covers script sources and skips arbitrary binary assets", async (t) => {
  const pathSeparator = String.fromCharCode(92);
  const syntheticWindowsPath = ["C:", "Users", "sample", "private.txt"].join(pathSeparator);
  const scripts = await createFixture(t, {
    extraFiles: {
      "skills/example/scripts/check.mjs": "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';\n",
      "skills/example/scripts/check.py": "PRIVATE_PATH = " + JSON.stringify(syntheticWindowsPath) + "\n",
      "skills/example/scripts/check.ps1": "-----BEGIN RSA PRIVATE KEY-----\nsynthetic\n-----END RSA PRIVATE KEY-----\n",
    },
  });

  await assert.rejects(scanPortablePayload(scripts.root), (error) => {
    assert.match(error.message, /skills\/example\/scripts\/check\.mjs: contains a GitHub token-like value/);
    assert.match(error.message, /skills\/example\/scripts\/check\.py: contains an escaped absolute Windows user path/);
    assert.match(error.message, /skills\/example\/scripts\/check\.ps1: contains private-key material/);
    return true;
  });

  const binary = await createFixture(t, {
    extraFiles: {
      "skills/example/assets/logo.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]),
    },
  });
  await assert.doesNotReject(() => scanPortablePayload(binary.root));
});

test("skills are optional and an MCP-only package validates", async (t) => {
  const fixture = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          remote: { type: "streamable-http", url: "https://example.invalid/mcp" }
        }
      }, null, 2) + "\n",
    },
  });
  await rm(path.join(fixture.root, "skills"), { recursive: true, force: true });
  await generateChecksums(fixture.root);
  await assert.doesNotReject(() => validateSkills(fixture.root));
  await assert.doesNotReject(() => validateMcp(fixture.root));
});

test("MCP remote headers reject invalid field syntax and case-insensitive duplicates", async (t) => {
  const invalidName = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.invalid/mcp",
            headers: { "Bad Header": "value" }
          }
        }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(invalidName.root), /invalid HTTP header name/);

  const invalidValue = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.invalid/mcp",
            headers: { "X-Test": "bad\nvalue" }
          }
        }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(invalidValue.root), /invalid HTTP header value/);

  const duplicateCase = await createFixture(t, {
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.invalid/mcp",
            headers: { "X-Test": "one", "x-test": "two" }
          }
        }
      }, null, 2) + "\n",
    },
  });
  await assert.rejects(validateMcp(duplicateCase.root), /duplicate case-insensitive header name/);
});

test("authoring classifier and root export-ignore rules stay equivalent", async () => {
  const attributes = await readFile(path.join(ROOT, ".gitattributes"), "utf8");
  const actual = new Set(
    attributes.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/") && line.endsWith(" export-ignore"))
      .map((line) => line.slice(1, -" export-ignore".length))
  );
  const expected = new Set([
    ...AUTHORING_ROOT_DIRS,
    ...AUTHORING_ROOT_FILES,
  ]);
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("portable payload includes MCP runtime files, generic resources, and client extensions", async (t) => {
  const fixture = await createFixture(t, {
    manifest: validManifest({ extensions: { "com.example.client": {} } }),
    extraFiles: {
      "mcp.json": JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          runtime: {
            type: "stdio",
            command: "./bin/server.mjs"
          }
        }
      }, null, 2) + "\n",
      "bin/server.mjs": "console.log('fixture');\n",
      "config/runtime.json": "{}\n",
      "plugin-resources/config/default.json": "{}\n",
      "com.example.client/config.json": "{}\n",
      "org.example.fileonly/hooks/hook.json": "{}\n",
    },
  });
  await validateMcp(fixture.root);
  const payload = await portablePayloadPaths(fixture.root);
  assert.ok(payload.includes("mcp.json"));
  assert.ok(payload.includes("bin/server.mjs"));
  assert.ok(payload.includes("config/runtime.json"));
  assert.ok(payload.includes("plugin-resources/config/default.json"));
  assert.ok(payload.includes("com.example.client/config.json"));
  assert.ok(payload.includes("org.example.fileonly/hooks/hook.json"));
  assert.equal(payload.some((relativePath) => relativePath.startsWith("scripts/")), false);
  assert.equal(payload.some((relativePath) => relativePath.startsWith("tests/")), false);
  assert.equal(payload.includes("package.json"), false);

  const badNamespace = await createFixture(t, {
    manifest: validManifest({ extensions: { "not-a-reverse-domain": {} } }),
  });
  await assert.rejects(validateManifest(badNamespace.root), /reverse-domain/);
});

test("unresolved scaffold placeholders fail before release", async (t) => {
  const token = "__" + "LICENSE_TEXT" + "__";
  const skillToken = "__" + "SKILL_NAME" + "__";
  const fixture = await createFixture(t, {
    extraFiles: {
      "docs/unresolved.md": "placeholder: " + token + "\n",
      ["skills/" + skillToken + "/SKILL.md"]: validSkill(),
    },
  });
  await assert.rejects(validateNoTemplatePlaceholders(fixture.root), /unresolved template token/);

  const dateFixture = await createFixture(t);
  await writeFile(path.join(dateFixture.root, "CHANGELOG.md"),
    "# Changelog\n\n## 1.0.0 - YYYY-MM-DD\n\n- Pending.\n", "utf8");
  await assert.rejects(validateNoTemplatePlaceholders(dateFixture.root), /template date YYYY-MM-DD/);
});

test("a real git archive contains exactly the portable payload", async (t) => {
  const fixture = await createFixture(t, {
    extraFiles: {
      "mise.lock": "maintenance lock\n",
      "pnpm-lock.yaml": "maintenance dependencies\n",
      "scripts/validator.mjs": "maintenance script\n",
      "tests/test.mjs": "maintenance test\n",
      "docs/maintenance.md": "maintenance doc\n",
      "VALIDATION.md": "maintenance validation notes\n",
      ".github/pull_request_template.md": "maintenance metadata\n",
      "AGENTS.md": "maintenance instructions\n",
      "CONTRIBUTING.md": "maintenance guide\n",
      "SECURITY.md": "maintenance policy\n",
      ".editorconfig": "root = true\n",
      "skills/example/scripts/worker.mjs": "portable skill script\n",
      "skills/example/docs/guide.md": "portable skill documentation\n",
      "skills/example/tests/fixture.mjs": "portable skill test resource\n",
      "skills/example/references/SECURITY.md": "portable security reference\n",
      "skills/example/AGENTS.md": "portable skill guidance\n",
      "skills/example/package.json": "portable skill data\n",
      "skills/example/mise.toml": "portable skill data\n",
      "skills/example/.gitattributes": "portable skill data\n",
    },
  });
  commitFixture(fixture.root);
  const fileCount = await validatePortableArchive(fixture.root, "HEAD");
  assert.equal(fileCount, (await portablePayloadPaths(fixture.root)).length);
});

test("a real git archive test catches maintenance files that lack export-ignore", async (t) => {
  const badAttributes = ATTRIBUTE_LINES.split("\n").filter((line) => line !== "/mise.lock export-ignore").join("\n") + "\n";
  const fixture = await createFixture(t, {
    attributes: badAttributes,
    extraFiles: { "mise.lock": "must not ship\n" },
  });
  commitFixture(fixture.root);
  await assert.rejects(validatePortableArchive(fixture.root, "HEAD"), /archive does not match.*mise\.lock/);
});

test("a real git archive must preserve payload bytes covered by checksums", async (t) => {
  const attributes = `${ATTRIBUTE_LINES}README.md export-subst\n`;
  const fixture = await createFixture(t, {
    attributes,
    readme: "# Fixture\n\n$Format:%H$\n[Skill](skills/example/SKILL.md)\n",
  });
  commitFixture(fixture.root);
  await assert.rejects(validatePortableArchive(fixture.root, "HEAD"), /archive content differs from candidate checkout: README\.md/);
});

test("node --test discovers nested test files and propagates failures", async (t) => {
  const fixture = await createFixture(t, {
    extraFiles: {
      "tests/unit/first.test.mjs": "import test from 'node:test'; test('first', () => {});\n",
      "tests/integration/second.test.mjs": "import test from 'node:test'; test('second', () => {});\n",
    },
  });
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const passed = spawnSync(process.execPath, ["--test"], { cwd: fixture.root, encoding: "utf8", env: environment });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /tests 2/);

  await writeFile(path.join(fixture.root, "tests/unit/failing.test.mjs"),
    "import test from 'node:test'; test('fails', () => { throw new Error('synthetic failure'); });\n", "utf8");
  const failed = spawnSync(process.execPath, ["--test"], { cwd: fixture.root, encoding: "utf8", env: environment });
  assert.equal(failed.status, 1);
});

test("release check rejects dirty candidates, changelog mismatch, and failing tests", async (t) => {
  const dirty = await createFixture(t);
  commitFixture(dirty.root);
  await writeFile(path.join(dirty.root, "README.md"), "# Dirty candidate\n", "utf8");
  await assert.rejects(runReleaseCheck(dirty.root, { quiet: true }), /clean Git working tree/);

  const whitespace = await createFixture(t, {
    readme: "# Fixture  \n\n[Skill](skills/example/SKILL.md)\n",
  });
  commitFixture(whitespace.root);
  await assert.rejects(runReleaseCheck(whitespace.root, { quiet: true }), /whitespace errors/);

  const versionMismatch = await createFixture(t, {
    manifest: validManifest({ version: "1.1.0" }),
    packageVersion: "1.1.0",
    changelogVersion: "1.0.0",
  });
  commitFixture(versionMismatch.root);
  await assert.rejects(runReleaseCheck(versionMismatch.root, { quiet: true }), /first CHANGELOG.md release heading/);

  const failingTests = await createFixture(t, {
    extraFiles: {
      "tests/fail.test.mjs": "import test from 'node:test'; test('candidate failure', () => { throw new Error('synthetic failure'); });\n",
    },
  });
  commitFixture(failingTests.root);
  await assert.rejects(runReleaseCheck(failingTests.root, { quiet: true }), /discovered test suite exited with 1/);
});

test("maintenance toolchain declarations agree with package.json, Mise, and lockfile", async () => {
  assert.deepEqual(await validateToolchainDeclarations(ROOT), { node: "24.21.0", pnpm: "11.19.0" });
  const mise = parseToml(await readFile(path.join(ROOT, "mise.toml"), "utf8"));
  assert.equal(mise.settings.auto_install, false);
  assert.equal(mise.settings.not_found_auto_install, false);
  assert.equal(mise.settings.task.run_auto_install, false);
  for (const task of Object.values(mise.tasks)) {
    const commands = Array.isArray(task.run) ? task.run : [task.run];
    assert.ok(commands.every((command) => typeof command === "string" && !command.includes("pnpm run")),
      "Mise tasks must invoke maintenance scripts directly instead of nesting pnpm run");
  }
});

test("pnpm run refuses stale dependencies without installing them implicitly", async (t) => {
  const workspace = parseDocument(await readFile(path.join(ROOT, "pnpm-workspace.yaml"), "utf8"), {
    schema: "core",
    stringKeys: true,
    uniqueKeys: true,
    logLevel: "error",
  });
  assert.equal(workspace.errors.length, 0);
  assert.deepEqual(workspace.toJS(), { verifyDepsBeforeRun: "error" });

  const fixture = await createFixture(t, {
    pnpmLock: "",
    packageJson: {
      name: "pnpm-no-implicit-install-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.19.0",
      scripts: {
        probe: "node -e \"require('node:fs').writeFileSync('probe-ran', 'yes')\"",
      },
      devDependencies: {
        "fixture-local-dependency": "file:./deps/local-dependency",
      },
    },
    extraFiles: {
      "deps/local-dependency/package.json": JSON.stringify({
        name: "fixture-local-dependency",
        version: "1.0.0",
        main: "index.js",
      }, null, 2) + "\n",
      "deps/local-dependency/index.js": "module.exports = true;\n",
    },
  });

  const pnpmCommand = process.platform === "win32" ? "pnpm.exe" : "pnpm";
  const environment = { ...process.env };
  // pnpm sets this override for child scripts; remove it so the fixture tests its own workspace policy.
  for (const key of Object.keys(environment)) {
    if (["pnpm_config_verify_deps_before_run", "npm_config_verify_deps_before_run"].includes(key.toLowerCase())) {
      delete environment[key];
    }
  }
  environment.npm_config_offline = "true";
  const result = spawnSync(pnpmCommand, ["run", "probe"], {
    cwd: fixture.root,
    encoding: "utf8",
    env: environment,
  });
  const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "pnpm run unexpectedly ran without installed dependencies:\n" + output);
  assert.match(output, /verifyDepsBeforeRun|ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/i);
  await assert.rejects(access(path.join(fixture.root, "node_modules")), { code: "ENOENT" });
  await assert.rejects(access(path.join(fixture.root, "probe-ran")), { code: "ENOENT" });
});

test("local OCI container parity is engine-neutral and excludes host node_modules", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const mise = await readFile(path.join(ROOT, "mise.toml"), "utf8");
  const dockerJob = await readFile(path.join(ROOT, "scripts/lib/docker-job.mjs"), "utf8");
  const { dockerRunArgs, resolveContainerEngine } = await import("../scripts/lib/docker-job.mjs");
  assert.equal(packageJson.scripts["ci:extended"], "node scripts/ci-extended.mjs");
  assert.equal(packageJson.scripts["jobs:local"], "node scripts/jobs-local.mjs");
  assert.match(mise, /tasks\."ci:extended"/);
  assert.match(mise, /tasks\."jobs:local"/);
  assert.equal(resolveContainerEngine({}), "docker");
  assert.equal(resolveContainerEngine({ WOIA_CONTAINER_ENGINE: "podman" }), "podman");
  assert.throws(() => resolveContainerEngine({ WOIA_CONTAINER_ENGINE: "podman --bad" }), /simple executable name/);
  const args = dockerRunArgs(ROOT, "node:24.21.0-bookworm", "11.19.0");
  const command = args.at(-1);
  assert.ok(args.includes("--rm"));
  assert.match(args[args.indexOf("--mount") + 1], /target=\/source,readonly/);
  assert.equal(args[args.indexOf("--workdir") + 1], "/workspace");
  assert.match(command, /tar --exclude='\.\/*node_modules/);
  assert.match(command, /if \[ -e \/workspace\/node_modules \]/);
  assert.match(command, /npm install --global pnpm@11\.19\.0/);
  assert.match(command, /pnpm install --frozen-lockfile/);
  assert.match(command, /node scripts\/ci-fast\.mjs/);
  assert.match(dockerJob, /WOIA_CONTAINER_ENGINE/);
  assert.match(dockerJob, /network access is required/);
  assert.match(dockerJob, /scripts\/ci-fast\.mjs/);
});

test("repository Markdown links resolve and portable links stay within the payload", async () => {
  await validateMarkdownLinks(ROOT);
});
