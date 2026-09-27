// Lists every api("…") call in public/app whose route the engine (src/) does not mention, so no control is "live"
// against a route that does not exist. Dynamic parts (${…}) are matched loosely.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (dir, ext, out = []) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) read(p, ext, out); else if (p.endsWith(ext)) out.push(p); } return out; };
const engine = read("src", ".ts").map((f) => readFileSync(f, "utf8")).join("\n");

let missing = 0;
for (const file of read("public/app", ".js")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bapi\(\s*(["'`])([^"'`]+)\1/g)) {
    const path = m[2].split("?")[0].replace(/\$\{[^}]+\}.*$/, "").replace(/\/$/, "");
    if (!path) continue;
    const route = "/api/" + path;
    const known = engine.includes(`"${route}"`) || engine.includes(`'${route}'`) || engine.includes(`\`${route}`)
      || engine.includes(`"${route}/`) || new RegExp(`\\\\/api\\\\/${path.replace(/[/-]/g, (c) => "\\\\" + c)}`).test(engine);
    if (!known) { console.log(`${file}: /api/${m[2]}`); missing++; }
  }
}
console.log(missing ? `${missing} call(s) to routes the engine does not have` : "routes ok");
process.exit(missing ? 1 : 0);
