/* SELF-103: Refresh CI keeps and draws its answer only for the owner who asked, on the same page, unlocked, and only if
   no newer read started. If the App lock came on, the owner switched person or page, or read again meanwhile, the late
   answer (or its error) is dropped, so owner CI data never reaches another person or the lock screen.
   The real public/app/settings/self-development-ci.js runs in Node next to stand-ins for the window's core modules; the
   read is held open by the test, so the change happens while it waits, with no timers.
   Mutation: drop still() from the refresh handler -> every late case fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/api.js": "export const api = (path, body) => globalThis.__ci.api(path, body);",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__ci.acts[name] = fn; };",
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const render = () => { globalThis.__ci.renders++; };",
  "app/core/state.js": `export const S = globalThis.__ci.S; export const E = { profiles: { isOwner: true } };
    export const ownerHere = () => globalThis.__ci.owner; export const activeId = () => globalThis.__ci.profile;`,
  "app/core/features.js": "export const markLive = () => {};",
};

async function ciPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-ci-stale-"));
  for (const dir of ["app/settings", "app/core"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "settings", "self-development-ci.js"), await readFile(new URL("../public/app/settings/self-development-ci.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const ci = { S: { view: "settings" }, owner: true, profile: null, locked: false, acts: {}, renders: 0,
    api: () => new Promise((resolve, reject) => held.push({ resolve, reject })) };
  const fields = { "self-ci-repo": { value: "owner/repo" }, "self-ci-selected": { value: "7" } };
  globalThis.__ci = ci;
  globalThis.document = { getElementById: (id) => fields[id] ?? (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && ci.locked } } : null) };
  t.after(async () => { delete globalThis.__ci; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "settings", "self-development-ci.js")).href);
  page.initCiQueue();
  const next = async () => { for (let i = 0; i < 50 && !held.length; i++) await Promise.resolve(); assert.ok(held.length, "the CI read was asked for"); return held.shift(); };
  return { page, ci, next };
}
const answer = { observedAt: "now", listComplete: true, rows: [{ number: 7, title: "Private fix", state: "unread", labels: [], checks: [], workflows: [], headSha: "a".repeat(40), exactHead: null }] };

test("with nothing changed, the CI read is kept and drawn", async (t) => {
  const { page, ci, next } = await ciPage(t);
  const refreshing = ci.acts["self-ci-refresh"]();
  (await next()).resolve(answer);
  await refreshing;
  assert.equal(ci.renders, 2, "drawn once as Reading, once with the answer");
  assert.match(page.ciQueueSection(), /Private fix/);
});

const LATE = [
  ["the App lock came on", (ci) => { ci.locked = true; }],
  ["another person's profile was switched to", (ci) => { ci.profile = "p-2"; }],
  ["the owner moved to another page", (ci) => { ci.S.view = "chat"; }],
];
for (const [what, change] of LATE) {
  test(`${what} while CI was read: the answer is not kept or drawn`, async (t) => {
    const { page, ci, next } = await ciPage(t);
    const refreshing = ci.acts["self-ci-refresh"]();
    const read = await next();
    change(ci);
    read.resolve(answer);
    await refreshing;
    assert.equal(ci.renders, 1, "only the Reading draw from before the change");
    assert.doesNotMatch(page.ciQueueSection(), /Private fix/);
  });
  test(`${what} while CI was read: its error is not kept or drawn`, async (t) => {
    const { page, ci, next } = await ciPage(t);
    const refreshing = ci.acts["self-ci-refresh"]();
    const read = await next();
    change(ci);
    read.reject(new Error("GitHub said no for owner/repo"));
    await refreshing;
    assert.equal(ci.renders, 1);
    assert.doesNotMatch(page.ciQueueSection(), /GitHub said no/);
  });
}
