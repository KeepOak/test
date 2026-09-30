/* SELF-103: the CI queue's Repository and PR-number fields are real fields, not greyed pictures of them. The window greys
   every field whose "sw:<id>" is not marked live (public/app/core/features.js greyOut), so a field the page reads but
   never registered could not be typed in, and the required repository could never be entered.
   The real public/app/settings/self-development-ci.js runs in Node next to stand-ins for the window's core modules.
   Mutation: drop "sw:self-ci-repo" (or "sw:self-ci-selected") from initCiQueue's markLive -> the first test fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/api.js": "export const api = async (path, body) => globalThis.__ci.api(path, body);",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__ci.acts[name] = fn; };",
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const render = () => { globalThis.__ci.renders++; };",
  "app/core/state.js": "export const E = { profiles: { isOwner: true } };",
  "app/core/features.js": "export const markLive = (ids) => { for (const id of ids) globalThis.__ci.live.add(id); };",
};

async function ciPage(t, fields = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-ci-fields-"));
  await mkdir(join(root, "app", "settings"), { recursive: true });
  await mkdir(join(root, "app", "core"), { recursive: true });
  await writeFile(join(root, "app", "settings", "self-development-ci.js"), await readFile(new URL("../public/app/settings/self-development-ci.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const calls = [];
  const ci = { acts: {}, live: new Set(), renders: 0, api: async (path, body) => { calls.push({ path, body }); return { observedAt: "now", rows: [], listComplete: true }; } };
  globalThis.__ci = ci;
  globalThis.document = { getElementById: (id) => (id in fields ? { value: fields[id] } : null) };
  t.after(async () => { delete globalThis.__ci; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "settings", "self-development-ci.js")).href);
  page.initCiQueue();
  return { page, ci, calls };
}

test("SELF-103: every field the CI queue draws is registered live, so the repository can be typed in", async (t) => {
  const { page, ci } = await ciPage(t);
  const ids = [...page.ciQueueSection().matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), ["self-ci-repo", "self-ci-selected"], "the two fields the section draws");
  for (const id of ids) assert.ok(ci.live.has(`sw:${id}`), `sw:${id} is live, so the window does not grey it`);
  assert.ok(ci.live.has("self-ci-refresh"));
});

test("SELF-103: Refresh CI sends the repository and the PR numbers typed into those fields", async (t) => {
  const { ci, calls } = await ciPage(t, { "self-ci-repo": " owner/repo ", "self-ci-selected": "7, 8" });
  await ci.acts["self-ci-refresh"]();
  assert.deepEqual(calls, [{ path: "self-development/ci", body: { repo: "owner/repo", selected: [7, 8] } }]);
});
