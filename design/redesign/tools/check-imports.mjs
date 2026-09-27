// Checks that every `import { a, b } from "./x.js"` in public/app names exports that x.js really has.
// `node --check` cannot see this, and one bad import stops the whole window from loading.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve("public/app");
const files = [];
const walk = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk(root);

const exportsOf = new Map();
function exported(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const src = readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1].split(",")) names.add(part.trim().split(/\s+as\s+/).pop());
  if (/export\s+default/.test(src)) names.add("default");
  exportsOf.set(file, names);
  return names;
}

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolve(dirname(file), m[2]);
    let names;
    try { names = exported(target); } catch { console.log(`${file}: missing module ${m[2]}`); bad++; continue; }
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name && !names.has(name)) { console.log(`${file.replace(root, "public/app")}: "${name}" is not exported by ${m[2]}`); bad++; }
    }
  }
}
console.log(bad ? `${bad} bad import(s)` : "imports ok");
process.exit(bad ? 1 : 0);
