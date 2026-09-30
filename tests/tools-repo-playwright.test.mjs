/* The design and verify scripts use the repo's own Playwright (require("playwright"), from the node_modules npm ci
   installs), never the copy inside an installed Branch app: that couples the tooling to the owner's install, and an
   update or an uninstall there would break every script. This reads every script under design/ and scripts/ and fails
   on any that names an installed app's folder.
   Mutation: put require("C:/Users/<you>/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright") back
   in any design/redesign/tools script and this goes red, naming the file and line. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const root = join(import.meta.dirname, "..");
const INSTALLED = /Programs[\\/]+Branch Agent/i;

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? scripts(path) : /\.(c|m)?js$/.test(entry.name) ? [path] : [];
  });
}

test("no design or verify script loads anything from an installed Branch app", () => {
  const found = [];
  for (const file of [...scripts(join(root, "design")), ...scripts(join(root, "scripts"))])
    readFileSync(file, "utf8").split("\n").forEach((line, i) => { if (INSTALLED.test(line)) found.push(`${relative(root, file)}:${i + 1}`); });
  assert.deepEqual(found, [], "use require(\"playwright\"), the repo's own copy");
});

test("a script in the tools folder resolves the repo's own Playwright", () => {
  const tools = join(root, "design", "redesign", "tools");
  const resolved = relative(root, createRequire(join(tools, "verify.cjs")).resolve("playwright"));
  assert.match(resolved, /^node_modules[\\/]playwright[\\/]/, `resolved ${resolved}`);
  assert.ok(scripts(tools).length > 50, "the tools folder is where it was");
});
