// What tsc wrote for a source that no longer exists. tsc never deletes an output, so after a source is deleted or
// renamed its old dist/ file stays, and a test or an import of it still finds it. That matters most when dist/ comes
// back from the CI build cache, built for an older tree: scripts/build-ts.mjs removes these before it compiles.
import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

// tsc's outputs for src/a.ts and src/a.cts, by suffix, and the source each comes from.
const OUTPUTS = [[".d.cts", ".cts"], [".cjs.map", ".cts"], [".cjs", ".cts"], [".d.ts", ".ts"], [".js.map", ".ts"], [".js", ".ts"]];
// Folders the copy steps own and write afresh on every build (scripts/copy-data.mjs, scripts/copy-suites.mjs).
const COPIED = ["bundled-add-ons/", "data/", "handbook/"];

/** The dist/ paths (relative, forward slashes) whose source is gone. `hasSource` answers for a src/-relative path. */
export function orphanedOutputs(outputs, hasSource) {
  return outputs.filter((file) => {
    if (COPIED.some((folder) => file.startsWith(folder))) return false;
    const match = OUTPUTS.find(([suffix]) => file.endsWith(suffix));
    return Boolean(match) && !hasSource(file.slice(0, -match[0].length) + match[1]);
  });
}

function files(dir, root = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, root, out);
    else out.push(relative(root, path).replace(/\\/g, "/"));
  }
  return out;
}

/** Remove every output in `dist` whose source in `src` is gone; returns what was removed. */
export function pruneDist(dist, src) {
  const sources = new Set(files(src));
  const removed = orphanedOutputs(files(dist), (file) => sources.has(file));
  for (const file of removed) rmSync(join(dist, file), { force: true });
  return removed;
}
