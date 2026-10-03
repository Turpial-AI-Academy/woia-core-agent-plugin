import {
  ROOT,
  scanPortablePayload,
  validateManifest,
  validateMarkdownLinks,
  validateMcp,
  validateNoTemplatePlaceholders,
  validateRootSafety,
  validateSkills,
} from "./lib/plugin.mjs";

const manifest = await validateManifest(ROOT);
await validateMcp(ROOT);
await validateNoTemplatePlaceholders(ROOT);
const warnings = await validateSkills(ROOT);
await validateMarkdownLinks(ROOT);
await validateRootSafety(ROOT);
await scanPortablePayload(ROOT);

for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`validate: ${manifest.name}@${manifest.version}`);
console.log("validate: official manifest/MCP schemas, template placeholders, Agent Skills metadata, links, payload paths, and secret scan OK");
