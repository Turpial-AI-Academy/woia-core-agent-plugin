import { ROOT, validateChecksums } from "./lib/plugin.mjs";

await validateChecksums(ROOT);
console.log("checksums: portable content checksums OK (CHECKSUMS.sha256 is distributed but not self-hashed)");
