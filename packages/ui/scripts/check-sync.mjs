// Fails when tokens.css or copy.json drift from the internal spec. The spec is private and not in the public repo;
// without it the files in src/ are the source of truth and there is nothing to compare.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = join(here, "../../../internal/ROOQ_PRODUCT_SPEC");
if (!existsSync(spec)) {
  console.log("spec not present, skipping: src/tokens.css and src/copy.json are canonical");
  process.exit(0);
}
const pairs = [
  ["src/tokens.css", "04-BRAND/tokens.css"],
  ["src/copy.json", "02-UX/copy.json"],
];
let failed = false;
for (const [local, source] of pairs) {
  const a = createHash("sha256").update(readFileSync(join(here, "..", local))).digest("hex");
  const b = createHash("sha256").update(readFileSync(join(spec, source))).digest("hex");
  console.log(`${a === b ? "in sync" : "DRIFT  "} ${local} ${a.slice(0, 12)} vs spec ${b.slice(0, 12)}`);
  failed ||= a !== b;
}
process.exit(failed ? 1 : 0);
