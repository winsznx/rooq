// Fails when tokens.css or copy.json drift from the internal spec, which is the source of truth.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = join(here, "../../../internal/ROOQ_PRODUCT_SPEC");
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
