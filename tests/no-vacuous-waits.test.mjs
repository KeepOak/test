/* Playwright's waitForFunction does not await a promise, so `page.waitForFunction(async () => ...)` resolves at once (a
   promise is truthy) and the wait checks nothing: `waitForFunction(async () => false)` returned in 19 ms. Sixteen tests
   and tools had it. A wait that must await (import(), fetch, api()) uses tests/wait-in-page.mjs waitInPage (or the verify
   tools' wait-in-page.cjs). This keeps the pattern out of every test and verify tool.
   Mutation: write `page.waitForFunction(async () => true)` in any test and this goes red, naming the file and line. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const VACUOUS = /\.waitForFunction\(\s*async\b/;

async function* files(dir, pattern) {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== "node_modules") yield* files(rel, pattern); }
    else if (pattern.test(entry.name)) yield rel;
  }
}

test("no test or verify tool waits with an async waitForFunction (it never waits)", async () => {
  const found = [];
  for (const [dir, pattern] of [["tests", /\.(mjs|js|cjs)$/], ["design/redesign/tools", /\.(cjs|mjs|js)$/]]) {
    for await (const rel of files(dir, pattern)) {
      if (["tests/no-vacuous-waits.test.mjs", "tests/wait-in-page.mjs", "design/redesign/tools/wait-in-page.cjs"].includes(rel)) continue; // they describe the pattern
      (await readFile(join(root, rel), "utf8")).split("\n").forEach((line, i) => {
        if (VACUOUS.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) found.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(found, [], `use waitInPage (tests/wait-in-page.mjs) instead: ${found.join(", ")}`);
});
