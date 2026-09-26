import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contributorInstructions = [
  "docs/agents/briefs/wave1/BUILD.md",
  "docs/agents/briefs/mac1/BUILD-MAC.md",
  "docs/agents/HANDOFF-2026-09-17-cloud.md",
];

/* Every shipped file: the window (public/) and the engine (src/). Redesign: the old window's public/settings-index.js is
   gone, so the whole of both folders is read rather than one file. */
async function shipped(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!["fonts", "art", "locales"].includes(entry.name)) out.push(...await shipped(path)); }
    else if (/\.(m?js|cjs|ts|html|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("shipped source and contributor instructions carry no AI-tool attribution watermark", async () => {
  const files = [...await shipped("public"), ...await shipped("src")];
  assert.ok(files.length > 100, "the shipped files were found");
  for (const path of files) {
    const text = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(text, /claude-session-files|generated (?:by|with) (?:\[?)claude|Co-Authored-By:\s*Claude/i, path);
  }
  for (const path of contributorInstructions) {
    const text = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(text, /Co-Authored-By:\s*Claude/i, path);
  }
});
