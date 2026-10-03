import { ROOT, generateChecksums } from "./lib/plugin.mjs";

const count = await generateChecksums(ROOT);
console.log(`checksums: wrote ${count} portable content entries`);
