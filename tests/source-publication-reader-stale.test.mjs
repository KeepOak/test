/* RES711: the Inbox's saved publication cards. Reading them keeps the answer only for the newest read, in the caller's
   context (the same owner on the same page, unlocked); Cancel and Retry redraw and say their result only in that context.
   A late answer after the App lock, a person switch or a page change leaves the cards as they were and says nothing.
   The real public/app/places/self-development-publication.js runs in Node next to stand-ins for the window's core
   modules; each read is held open by the test.
   Mutations: drop the check before `publications = fresh` -> the read cases fail; drop still() in Cancel -> its cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const renderNow = () => { globalThis.__sp.renders++; };",
  "app/core/api.js": "export const api = (path, body) => globalThis.__sp.api(path, body);",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__sp.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/ui.js": "export const toast = (m) => globalThis.__sp.toasts.push(m);",
  "app/core/state.js": "export const S = globalThis.__sp.S; export const ownerHere = () => globalThis.__sp.owner; export const activeId = () => globalThis.__sp.profile;",
  "i18n.js": "export const t = (key) => key;",
};

async function cards(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-publication-reader-"));
  for (const dir of ["app/places", "app/core"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "places", "self-development-publication.js"), await readFile(new URL("../public/app/places/self-development-publication.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const sp = { S: { view: "inbox" }, owner: true, profile: null, locked: false, toasts: [], acts: {}, renders: 0,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })) };
  globalThis.__sp = sp;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && sp.locked } } : null) };
  t.after(async () => { delete globalThis.__sp; delete globalThis.document; await discardTemp(root); });
  const mod = await import(pathToFileURL(join(root, "app", "places", "self-development-publication.js")).href);
  const next = async () => { for (let i = 0; i < 50 && !held.length; i++) await Promise.resolve(); assert.ok(held.length, "a read was asked for"); return held.shift(); };
  return { mod, sp, next };
}
const blocked = { publications: [{ id: "p1", state: "blocked", repository: "owner/private-repo", branch: "branch/change", reason: "GitHub is unavailable" }] };
const CHANGES = [
  ["the App lock came on", (sp) => { sp.locked = true; }],
  ["another person's profile was switched to", (sp) => { sp.profile = "p-2"; }],
  ["the owner moved to another page", (sp) => { sp.S.view = "chat"; }],
];

test("with nothing changed, the publications read are kept", async (t) => {
  const { mod, next } = await cards(t);
  const reading = mod.readSourcePublications();
  (await next()).resolve(blocked);
  assert.equal(await reading, true);
  assert.match(mod.sourcePublicationCards(), /private-repo/);
});

for (const [what, change] of CHANGES) {
  test(`${what} while the publications were read: the late answer is not kept`, async (t) => {
    const { mod, sp, next } = await cards(t);
    const reading = mod.readSourcePublications();
    const read = await next();
    change(sp);
    read.resolve(blocked);
    assert.equal(await reading, false);
    assert.equal(mod.sourcePublicationCards(), "");
  });
  test(`${what} after Cancel was answered: the cards are not redrawn and nothing is said`, async (t) => {
    const { sp, next } = await cards(t);
    const cancelling = sp.acts["source-publication-cancel"]({ dataset: { id: "p1" }, disabled: false });
    const done = await next();
    change(sp);
    done.resolve({});
    await cancelling;
    assert.equal(sp.renders, 0);
    assert.deepEqual(sp.toasts, []);
  });
  test(`${what} before Retry failed: its error is not shown`, async (t) => {
    const { sp, next } = await cards(t);
    const retrying = sp.acts["source-publication-retry"]({ dataset: { id: "p1" }, disabled: false });
    const done = await next();
    change(sp);
    done.reject(new Error("GitHub is unavailable"));
    await retrying;
    assert.deepEqual(sp.toasts, []);
  });
}

test("an older read answered after a newer one is not kept", async (t) => {
  const { mod, next } = await cards(t);
  const older = mod.readSourcePublications();
  const first = await next();
  const newer = mod.readSourcePublications();
  const second = await next();
  second.resolve({ publications: [] });
  await newer;
  first.resolve(blocked);
  assert.equal(await older, false);
  assert.equal(mod.sourcePublicationCards(), "");
});
