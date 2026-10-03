import Ajv2020 from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const SCHEMA_FILE = path.join(ROOT, "scripts", "schemas", "agent-plugins-1.0.0.plugin.schema.json");
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const MCP_SCHEMA_FILE = path.join(ROOT, "scripts", "schemas", "agent-plugins-1.0.0.mcp.schema.json");
export const PORTABLE_ROOT_FILES = Object.freeze([
  "plugin.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "CHECKSUMS.sha256",
]);
export const EXTENSION_NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

let manifestValidatorPromise;
let mcpValidatorPromise;

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`));
}

function filePath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

async function gitCandidatePaths(root) {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.toString("utf8").split("\0").filter(Boolean);
  } catch (error) {
    throw new Error(`Could not enumerate candidate files with Git: ${error.message}`);
  }
}

export const AUTHORING_ROOT_FILES = Object.freeze([
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "README.plugin.md",
  "VALIDATION.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "mise.toml",
  "mise.lock",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
]);
export const AUTHORING_ROOT_DIRS = Object.freeze([
  ".github/",
  "scripts/",
  "tests/",
  "docs/",
]);

function isAuthoringPath(relativePath) {
  return AUTHORING_ROOT_FILES.includes(relativePath)
    || AUTHORING_ROOT_DIRS.some((prefix) => relativePath.startsWith(prefix));
}

export async function portablePayloadPaths(root = ROOT) {
  const candidatePaths = await gitCandidatePaths(root);
  const selected = candidatePaths.filter((relativePath) => !isAuthoringPath(relativePath));
  const selectedSet = new Set(selected);
  const missing = PORTABLE_ROOT_FILES.filter((relativePath) => !selectedSet.has(relativePath));
  assert(missing.length === 0, `Portable payload is missing required files: ${missing.join(", ")}`);
  return selected.sort(comparePaths);
}

export async function checksumPayloadPaths(root = ROOT) {
  return (await portablePayloadPaths(root)).filter((relativePath) => relativePath !== "CHECKSUMS.sha256");
}

export async function parseFrontmatter(file, root = ROOT) {
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  assert(lines[0] === "---", `${path.relative(root, file)} must start with YAML frontmatter`);
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  assert(end > 1, `${path.relative(root, file)} frontmatter is not closed`);

  const document = parseDocument(lines.slice(1, end).join("\n"), {
    schema: "core",
    stringKeys: true,
    uniqueKeys: true,
    logLevel: "error",
  });
  assert(document.errors.length === 0,
    `${path.relative(root, file)} has invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`);
  const data = document.toJS({ maxAliasCount: 100 });
  assert(data !== null && typeof data === "object" && !Array.isArray(data),
    `${path.relative(root, file)} frontmatter must be a YAML mapping`);
  return { data, content, lines, body: lines.slice(end + 1).join("\n") };
}

function characterLength(value) {
  return [...value].length;
}

function validateSkillProperties(data, directoryName, relativePath) {
  const warnings = [];
  const supportedFields = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);

  for (const field of Object.keys(data)) {
    if (!supportedFields.has(field)) warnings.push(`${relativePath}: unknown Agent Skills field "${field}"; review against the current specification`);
  }

  assert(typeof data.name === "string", `${relativePath} name must be a string`);
  const nameLength = characterLength(data.name);
  assert(nameLength >= 1 && nameLength <= 64, `${relativePath} name must be 1-64 characters`);
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name),
    `${relativePath} name may contain lowercase letters, numbers, and single hyphens only`);
  assert(data.name === directoryName, `${relativePath} name must match directory name "${directoryName}"`);

  assert(typeof data.description === "string" && data.description.trim().length > 0,
    `${relativePath} description must be a non-empty string`);
  assert(characterLength(data.description) <= 1024, `${relativePath} description must be at most 1024 characters`);

  if ("license" in data) assert(typeof data.license === "string", `${relativePath} license must be a string`);
  if ("compatibility" in data) {
    assert(typeof data.compatibility === "string" && characterLength(data.compatibility) >= 1
      && characterLength(data.compatibility) <= 500,
    `${relativePath} compatibility must be 1-500 characters`);
  }
  if ("metadata" in data) {
    assert(data.metadata !== null && typeof data.metadata === "object" && !Array.isArray(data.metadata),
      `${relativePath} metadata must be a mapping of string keys to string values`);
    for (const [key, value] of Object.entries(data.metadata)) {
      assert(typeof key === "string" && typeof value === "string",
        `${relativePath} metadata values must be strings`);
    }
  }
  if ("allowed-tools" in data) {
    assert(typeof data["allowed-tools"] === "string" && data["allowed-tools"].trim().length > 0,
      `${relativePath} allowed-tools must be a non-empty space-separated string`);
  }
  return warnings;
}

export async function markdownFiles(root = ROOT) {
  const repositoryPaths = await gitCandidatePaths(root);
  return repositoryPaths.filter((relativePath) => /\.md(?:\.template)?$/i.test(relativePath)).sort(comparePaths);
}

export async function validateMarkdownLinks(root = ROOT) {
  const failures = [];
  const rootReal = await realpath(root);
  const repositoryPaths = new Set(await gitCandidatePaths(root));
  const payloadPaths = new Set(await portablePayloadPaths(root));
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;

  for (const relativePath of await markdownFiles(root)) {
    const file = filePath(root, relativePath);
    const content = await readFile(file, "utf8");
    let match;
    while ((match = linkPattern.exec(content))) {
      const rawTarget = match[1].trim();
      const targetMatch = rawTarget.startsWith("<")
        ? rawTarget.match(/^<([^>]+)>/)
        : rawTarget.match(/^(\S+)/);
      let target = targetMatch?.[1] ?? "";
      if (!target || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

      target = target.split(/[?#]/, 1)[0];
      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        failures.push(`${relativePath} -> ${target} (invalid URL encoding)`);
        continue;
      }

      const resolved = path.resolve(path.dirname(file), decodedTarget);
      if (!isWithin(root, resolved)) {
        failures.push(`${relativePath} -> ${target} (escapes plugin root)`);
        continue;
      }

      let resolvedReal;
      try {
        resolvedReal = await realpath(resolved);
      } catch {
        failures.push(`${relativePath} -> ${target} (missing)`);
        continue;
      }
      if (!isWithin(rootReal, resolvedReal)) {
        failures.push(`${relativePath} -> ${target} (escapes plugin root through a link)`);
        continue;
      }

      const targetPath = path.relative(root, resolved).split(path.sep).join("/");
      const allowedTargets = payloadPaths.has(relativePath) ? payloadPaths : repositoryPaths;
      if (!allowedTargets.has(targetPath)) {
        const scope = payloadPaths.has(relativePath) ? "portable payload" : "repository tree";
        failures.push(`${relativePath} -> ${target} (not included in the ${scope})`);
      }
    }
  }
  assert(failures.length === 0, `Invalid internal Markdown links:\n- ${failures.join("\n- ")}`);
}

async function getManifestValidator() {
  if (!manifestValidatorPromise) {
    manifestValidatorPromise = readJson(SCHEMA_FILE).then((schema) => {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      return ajv.compile(schema);
    });
  }
  return manifestValidatorPromise;
}

export async function validateManifest(root = ROOT) {
  const manifest = await readJson(path.join(root, "plugin.json"));
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "plugin.json must contain an object");
  const validate = await getManifestValidator();
  const valid = validate(manifest);
  if (!valid) {
    const details = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`plugin.json does not match the official Agent Plugins 1.0.0 schema: ${details}`);
  }
  assert(manifest.$schema === SCHEMA, `plugin.json $schema must be ${SCHEMA}`);
  for (const namespace of Object.keys(manifest.extensions ?? {})) {
    assert(EXTENSION_NAMESPACE_RE.test(namespace),
      `plugin.json extension namespace must use reverse-domain form: ${namespace}`);
  }
  return manifest;
}

async function getMcpValidator() {
  if (!mcpValidatorPromise) {
    mcpValidatorPromise = readJson(MCP_SCHEMA_FILE).then((schema) => {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      return ajv.compile(schema);
    });
  }
  return mcpValidatorPromise;
}

function assertNoTraversalSuffix(value, prefix, label) {
  const suffix = value.slice(prefix.length).replace(/^\//, "");
  const segments = suffix.split("/").filter(Boolean);
  assert(!segments.includes(".."), `${label} must not escape its declared root: ${value}`);
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  return Boolean(match && Number(match[1]) === 127);
}

async function validateMcpSemantics(document, root) {
  for (const [name, server] of Object.entries(document.mcpServers)) {
    const label = `mcpServers.${name}`;
    if (server.type === "stdio") {
      if (server.command.includes("/") || server.command.includes("\\")) {
        assert(server.command.startsWith("./"), `${label}.command path must begin with ./`);
        assertNoTraversalSuffix(server.command, "./", `${label}.command`);
        const resolved = path.resolve(root, server.command);
        assert(isWithin(root, resolved), `${label}.command escapes plugin root`);
        const commandStat = await lstat(resolved).catch(() => null);
        assert(commandStat?.isFile(), `${label}.command does not resolve to a bundled file: ${server.command}`);
      }
      if (server.cwd?.startsWith("./")) assertNoTraversalSuffix(server.cwd, "./", `${label}.cwd`);
      if (server.cwd?.startsWith("${PLUGIN_ROOT}")) assertNoTraversalSuffix(server.cwd, "${PLUGIN_ROOT}", `${label}.cwd`);
      if (server.cwd?.startsWith("${PLUGIN_DATA}")) assertNoTraversalSuffix(server.cwd, "${PLUGIN_DATA}", `${label}.cwd`);
    } else {
      let url;
      try {
        url = new URL(server.url);
      } catch {
        throw new Error(`${label}.url must be an absolute HTTP(S) URL`);
      }
      assert(url.protocol === "http:" || url.protocol === "https:", `${label}.url must use HTTP or HTTPS`);
      assert(!url.username && !url.password, `${label}.url must not contain user information`);
      assert(!url.hash, `${label}.url must not contain a fragment`);
      if (url.protocol === "http:") {
        assert(isLoopbackHost(url.hostname), `${label}.url must use HTTPS unless the host is loopback`);
      }
      const seenHeaders = new Set();
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        assert(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key), `${label}.headers contains invalid HTTP header name: ${key}`);
        assert(!/[\r\n\0]/.test(value) && !/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),
          `${label}.headers contains invalid HTTP header value for ${key}`);
        const folded = key.toLowerCase();
        assert(!seenHeaders.has(folded), `${label}.headers contains duplicate case-insensitive header name: ${key}`);
        seenHeaders.add(folded);
      }
    }
  }
}

export async function validateMcp(root = ROOT) {
  const file = path.join(root, "mcp.json");
  const stat = await lstat(file).catch(() => null);
  if (!stat) return null;
  assert(stat.isFile(), "mcp.json must be a regular file");
  const document = await readJson(file);
  const validate = await getMcpValidator();
  const valid = validate(document);
  if (!valid) {
    const details = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`mcp.json does not match the official Agent Plugins 1.0.0 MCP schema: ${details}`);
  }
  assert(document.$schema === MCP_SCHEMA, `mcp.json $schema must be ${MCP_SCHEMA}`);
  await validateMcpSemantics(document, root);
  return document;
}

export async function validateSkills(root = ROOT) {
  const skillsRoot = path.join(root, "skills");
  const skillsStat = await lstat(skillsRoot).catch(() => null);
  if (!skillsStat) return [];
  assert(skillsStat.isDirectory(), "skills/ must be a directory when present");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillDirs = entries.filter((entry) => entry.isDirectory());

  const warnings = [];
  for (const entry of skillDirs) {
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    const stat = await lstat(skillFile).catch(() => null);
    assert(stat?.isFile(), `skills/${entry.name}/SKILL.md is required and must be a regular file`);
    const relativePath = path.relative(root, skillFile).split(path.sep).join("/");
    const { data, lines } = await parseFrontmatter(skillFile, root);
    warnings.push(...validateSkillProperties(data, entry.name, relativePath));
    if (lines.length > 500) warnings.push(`${entry.name}: SKILL.md is ${lines.length} lines; move task-specific detail to references`);
  }
  return warnings;
}

export async function validateRootSafety(root = ROOT) {
  for (const relativePath of await portablePayloadPaths(root)) {
    const fullPath = filePath(root, relativePath);
    const stat = await lstat(fullPath);
    assert(!stat.isSymbolicLink(), `${relativePath} must not be a symlink in the portable payload`);
    assert(stat.isFile(), `${relativePath} must be a regular file in the portable payload`);
  }
}

export async function sha256File(root, relativePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath(root, relativePath)));
  return hash.digest("hex");
}

export async function expectedChecksumLines(root = ROOT) {
  const lines = [];
  for (const relativePath of await checksumPayloadPaths(root)) {
    lines.push(`${await sha256File(root, relativePath)}  ${relativePath}`);
  }
  return lines;
}

export async function generateChecksums(root = ROOT) {
  const checksumFile = path.join(root, "CHECKSUMS.sha256");
  const checksumStat = await lstat(checksumFile).catch(() => null);
  if (checksumStat) {
    assert(checksumStat.isFile(), "CHECKSUMS.sha256 must be a regular file");
  } else {
    await writeFile(checksumFile, "", "utf8");
  }

  const lines = await expectedChecksumLines(root);
  await writeFile(checksumFile, `${lines.join("\n")}\n`, "utf8");
  return lines.length;
}

export async function validateChecksums(root = ROOT) {
  const checksumFile = path.join(root, "CHECKSUMS.sha256");
  const raw = (await readFile(checksumFile, "utf8")).replace(/\r\n?/g, "\n");
  const actual = raw.split("\n");
  if (actual.at(-1) === "") actual.pop();
  const expected = await expectedChecksumLines(root);
  assert(actual.length === expected.length,
    `CHECKSUMS.sha256 contains ${actual.length} entries but ${expected.length} portable content files require checksums`);
  for (let index = 0; index < expected.length; index++) {
    assert(actual[index] === expected[index], `CHECKSUMS.sha256 mismatch at line ${index + 1}: ${expected[index].split("  ")[1]}`);
  }
}

function decodeReasonableText(buffer) {
  if (buffer.length === 0) return "";

  const utf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const utf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const utf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const bytes = buffer.subarray(utf8Bom ? 3 : 0);

  if (!utf16Le && !utf16Be) {
    let controls = 0;
    for (const byte of bytes) {
      if (byte === 0) return null;
      if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) || byte === 0x7f) {
        controls++;
      }
    }
    if (controls > Math.max(1, bytes.length * 0.01)) return null;
  }

  let text;
  try {
    const encoding = utf16Le ? "utf-16le" : utf16Be ? "utf-16be" : "utf-8";
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    return null;
  }

  const characters = [...text];
  let controls = 0;
  for (const character of characters) {
    const codePoint = character.codePointAt(0);
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0c && codePoint !== 0x0d)
      || codePoint === 0x7f) {
      controls++;
    }
  }
  if (controls > Math.max(1, characters.length * 0.01)) return null;
  return text;
}


export async function validateNoTemplatePlaceholders(root = ROOT) {
  const failures = [];
  const tokenPattern = /__[A-Z0-9_]+__/g;

  for (const relativePath of await gitCandidatePaths(root)) {
    const pathTokens = relativePath.match(tokenPattern) ?? [];
    for (const token of pathTokens) failures.push(`${relativePath}: unresolved template token ${token} in path`);

    const fullPath = filePath(root, relativePath);
    const stat = await lstat(fullPath).catch(() => null);
    if (!stat?.isFile()) continue;
    const content = decodeReasonableText(await readFile(fullPath));
    if (content === null) continue;

    const contentTokens = content.match(tokenPattern) ?? [];
    for (const token of [...new Set(contentTokens)]) {
      failures.push(`${relativePath}: unresolved template token ${token}`);
    }
    if (relativePath === "CHANGELOG.md" && content.includes("YYYY-MM-DD")) {
      failures.push("CHANGELOG.md: unresolved template date YYYY-MM-DD");
    }
  }

  assert(failures.length === 0, `Unresolved plugin-repository template placeholders:\n- ${failures.join("\n- ")}`);
}

export async function scanPortablePayload(root = ROOT) {
  const bad = [];
  const patterns = [
    { re: /\b[A-Z]:\\Users\\[^\\\s]+/i, reason: "contains an absolute Windows user path" },
    { re: /\b[A-Z]:\\\\Users\\\\[^"\\\s]+/i, reason: "contains an escaped absolute Windows user path" },
    { re: /\/(?:home|Users)\/[^/\s]+/, reason: "contains an absolute Unix user path" },
    { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, reason: "contains private-key material" },
    { re: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/i, reason: "contains a GitHub token-like value" },
    { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/, reason: "contains an API-key-like value" },
    { re: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: "contains a Google API-key-like value" },
    { re: /\bAKIA[0-9A-Z]{16}\b/, reason: "contains an AWS access-key-like value" },
  ];

  for (const relativePath of await portablePayloadPaths(root)) {
    const content = decodeReasonableText(await readFile(filePath(root, relativePath)));
    if (content === null) continue;
    for (const pattern of patterns) {
      if (pattern.re.test(content)) bad.push(`${relativePath}: ${pattern.reason}`);
    }
  }
  assert(bad.length === 0, `Portable payload safety scan failed:\n- ${bad.join("\n- ")}`);
}
