import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../public/app/settings/", import.meta.url));
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".js") ? [path] : [];
  }));
  return files.flat();
}

test("Settings rows must use the shared kit rather than new inline containers", async () => {
  const offenders = [];
  for (const path of await sources(root)) {
    if (relative(root, path) === "row-kit.js") continue;
    const source = await readFile(path, "utf8");
    if (/<(?:div|label)\b[^>]*\bclass\s*=\s*["'][^"']*\bctl\b/.test(source.replace(/\\["']/g, '"'))) offenders.push(relative(root, path));
  }
  assert.deepEqual(offenders, [], "Import controlRow or a semantic row from row-kit.js");
});
