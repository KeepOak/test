// A git merge driver for the locale files (public/locales/*.json, see .gitattributes), which merges them by key
// instead of by line: a key only one side added, changed or removed is taken from that side, whatever lines it sits
// near. Only a key both sides set to different words, or one side changed while the other removed, is a real conflict;
// then the file is merged line by line as git would (git merge-file, with conflict markers) and the merge stops there.
// Installed per clone by scripts/setup-merge-drivers.mjs:
//   git config merge.jsonkeys.name "Merge JSON string tables by key"
//   git config merge.jsonkeys.driver "node scripts/merge-json-keys.mjs %O %A %B"
// Git calls it with the common ancestor (%O), ours (%A, which receives the result) and theirs (%B).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localeText } from "./locale-order.mjs";

const has = (table, key) => Object.hasOwn(table, key);

/** Base, ours and theirs merged by key: { merged, conflicts: [key...] }. */
export function mergeTables(base, ours, theirs) {
  const merged = { ...ours }, conflicts = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = has(base, key) ? base[key] : undefined, o = has(ours, key) ? ours[key] : undefined, t = has(theirs, key) ? theirs[key] : undefined;
    if (t === b || t === o) continue; // theirs left it alone, or made the same change as ours
    if (o === b) { if (t === undefined) delete merged[key]; else merged[key] = t; continue; } // only theirs changed it
    conflicts.push(key); // both changed it, differently
  }
  return { merged, conflicts };
}

function lineMerge(base, ours, theirs) {
  const run = spawnSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", ours, base, theirs], { encoding: "utf8" });
  return run.status === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  let tables;
  try { tables = [basePath, oursPath, theirsPath].map((path) => JSON.parse(readFileSync(path, "utf8"))); }
  catch { process.exit(lineMerge(basePath, oursPath, theirsPath)); } // not a whole table on some side: merge as text
  const { merged, conflicts } = mergeTables(...tables);
  if (conflicts.length) {
    console.error(`merge-json-keys: both sides changed ${conflicts.length} key(s) differently: ${conflicts.slice(0, 5).join(", ")}`);
    process.exit(lineMerge(basePath, oursPath, theirsPath));
  }
  writeFileSync(oursPath, localeText(merged));
  process.exit(0);
}
