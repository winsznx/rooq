// The source uses extensionless relative imports so Next can bundle it directly. Node ESM needs explicit `.js`, so
// this adds it to every relative specifier in the compiled output (code and declarations).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "dist");
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;

function withExtension(file, spec) {
  if (/\.(js|json)$/.test(spec)) return spec;
  const base = resolve(dirname(file), spec);
  if (existsSync(`${base}.js`)) return `${spec}.js`;
  if (existsSync(join(base, "index.js"))) return `${spec}/index.js`;
  throw new Error(`${file}: can't resolve ${spec}`);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".js") || path.endsWith(".d.ts")) {
      const text = readFileSync(path, "utf8");
      const next = text.replace(SPECIFIER, (_, lead, quote, spec) => `${lead}${quote}${withExtension(path, spec)}${quote}`);
      if (next !== text) writeFileSync(path, next);
    }
  }
}

walk(dist);
