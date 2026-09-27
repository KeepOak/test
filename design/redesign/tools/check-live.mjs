// A control may be marked live only if something real handles it: an on("name") handler with a body for a data-act, or a
// 'change' listener that names the switch's id. A form field marked "sw:<id>" (a text box, a search box, a dialog's field)
// may instead be read by code that names that one field: $("#id"), getElementById("id"), id === "id" (or !==),
// id.startsWith("id") for a family of fields, or dataset.<key> for one keyed by its data-sw.
// Prints every live id with nothing behind it, and every empty handler.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk("public/app");
const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
const handled = new Set([...all.matchAll(/\bon\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
const EMPTY = /on\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*(?:\/\/[^\n]*\s*)*\}\s*\)/g;

let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(EMPTY)) { console.log(`${f}: ${m[1]} has an empty handler`); bad++; }
  const ids = [...src.matchAll(/markLive\(\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]));
  const block = /export const live\s*=\s*\{([\s\S]*?)\};/.exec(src);
  if (block) ids.push(...[...block[1].matchAll(/["']([^"']+)["']\s*:/g)].map((m) => m[1]));
  for (const id of ids) {
    if (id.startsWith("sw:")) {
      const sw = id.slice(3);
      const switchRule = /addEventListener\(\s*["']change["']/.test(src) && src.split(sw).length - 1 >= 2;
      const q = sw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fieldRule = new RegExp(`["'\`]#${q}["'\`]|getElementById\\(\\s*["'\`]${q}["'\`]|[!=]==\\s*["'\`]${q}["'\`]|startsWith\\(\\s*["'\`]${q}["'\`]|dataset\\??\\.${q}\\b`).test(src);
      if (!switchRule && !fieldRule) { console.log(`${f}: ${id} has no change handler`); bad++; }
    } else if (!handled.has(id)) { console.log(`${f}: ${id} has no on() handler`); bad++; }
  }
}
console.log(bad ? `${bad} live control(s) with nothing behind them` : "live ok");
process.exit(bad ? 1 : 0);
