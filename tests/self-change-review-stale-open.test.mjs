/* SELF-026: the Inbox's source review opens only over what asked for it. It reads the draft and the diff first; if the
   owner closed a dialog, opened another, moved to another page, switched person or the App lock came on meanwhile, the
   late answer is dropped instead of opening a review over newer work.
   The real public/app/places/self-change-review.js runs in Node next to stand-ins for the window's core modules; each
   read is held open by the test, so the change happens while the review is waiting, with no timers.
   Mutations: drop `dialog() === opened` -> the close-then-nothing and replaced cases fail; drop `S.view === view` -> the
   navigation case fails; drop the dlg-close click bump -> the closed case fails; drop the Escape bump -> the Escape case fails; drop `allowed()` -> the lock case fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\");",
  "app/core/state.js": "export const S = globalThis.__sr.S; export const ownerHere = () => globalThis.__sr.owner; export const activeId = () => globalThis.__sr.profile;",
  "app/core/api.js": "export const api = (path, body) => globalThis.__sr.api(path, body);",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__sr.openDlg(o); export const closeDlg = () => { globalThis.__sr.dlg = null; };
    export const dialog = () => globalThis.__sr.dlg; export const toast = (m) => globalThis.__sr.toasts.push(m);`,
  "app/core/actions.js": "export const on = () => {};",
  "app/core/features.js": "export const markLive = () => {};",
  "i18n.js": "export const t = (key) => key;",
};

async function reviewPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-source-review-"));
  await mkdir(join(root, "app", "places"), { recursive: true });
  await mkdir(join(root, "app", "core"), { recursive: true });
  await writeFile(join(root, "app", "places", "self-change-review.js"), await readFile(new URL("../public/app/places/self-change-review.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [], opened = [], clicks = [];
  const sr = { S: { view: "inbox" }, owner: true, profile: null, locked: false, dlg: null, toasts: [],
    api: (path) => new Promise((resolve, reject) => held.push({ path, resolve, reject })),
    openDlg: (o) => { opened.push(o); sr.dlg = { review: o, querySelector: () => null }; return sr.dlg; } };
  globalThis.__sr = sr;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && sr.locked } } : null),
    addEventListener: (type, fn, capture) => { if (capture) clicks.push({ type, fn }); } };
  globalThis.addEventListener = () => {};
  t.after(async () => { delete globalThis.__sr; delete globalThis.document; delete globalThis.addEventListener; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "places", "self-change-review.js")).href);
  page.initSourceReview(async () => {});
  const settle = async (path, how, value) => {
    for (let i = 0; i < 50 && !held.some((h) => h.path.endsWith(path)); i++) await Promise.resolve();
    const at = held.findIndex((h) => h.path.endsWith(path));
    assert.ok(at >= 0, `the review asked for its ${path}`);
    held.splice(at, 1)[0][how](value);
  };
  const answer = (path, value) => settle(path, "resolve", value), fail = (path, error) => settle(path, "reject", error);
  const fire = (type, event) => { for (const one of clicks) if (one.type === type) one.fn(event); };
  const closeClick = () => fire("click", { target: { closest: (q) => (q.includes("dlg-close") ? {} : null) } });
  const escape = () => fire("keydown", { key: "Escape" });
  return { page, sr, opened, answer, fail, closeClick, escape };
}

const waiting = { id: "r1", text: "Remove the Export button", status: "waiting" };
const approved = { id: "r2", text: "Remove the Export button", status: "approved" };
const diff = { files: [], untracked: [] };
const draft = { diff, review: { revision: 1 }, contract: {} };
const blocks = () => "<div>diff</div>";

test("with nothing changed, the review opens once its draft and diff are read", async (t) => {
  const { page, opened, answer } = await reviewPage(t);
  const open = page.openSourceReview(approved, blocks);
  await answer("/draft", draft);
  await open;
  assert.equal(opened.length, 1, "the publication review opened");
});

test("a dialog closed while the diff was read: the late review does not open", async (t) => {
  const { page, sr, opened, answer, closeClick } = await reviewPage(t);
  sr.dlg = { other: true };
  const open = page.openSourceReview(waiting, blocks);
  closeClick();
  sr.dlg = null;
  await answer("/diff", diff);
  await open;
  assert.equal(opened.length, 0);
});

test("a dialog opened and closed again while the draft was read still counts: the late review does not open", async (t) => {
  const { page, sr, opened, answer, closeClick } = await reviewPage(t);
  const open = page.openSourceReview(approved, blocks);
  sr.dlg = { other: true };
  closeClick();
  sr.dlg = null;
  await answer("/draft", draft);
  await open;
  assert.equal(opened.length, 0);
});

test("another dialog replaced the view while the draft was read: the late review does not cover it", async (t) => {
  const { page, sr, opened, answer } = await reviewPage(t);
  const open = page.openSourceReview(approved, blocks);
  const newer = { newer: true };
  sr.dlg = newer;
  await answer("/draft", draft);
  await open;
  assert.equal(opened.length, 0);
  assert.equal(sr.dlg, newer, "the newer dialog is still the one open");
});

test("the owner moved to another page while the diff was read: the late review does not open", async (t) => {
  const { page, sr, opened, answer } = await reviewPage(t);
  const open = page.openSourceReview(waiting, blocks);
  sr.S.view = "chat";
  await answer("/diff", diff);
  await open;
  assert.equal(opened.length, 0);
});

test("the App lock came on while the diff was read: nothing opens over the lock", async (t) => {
  const { page, sr, opened, answer } = await reviewPage(t);
  const open = page.openSourceReview(waiting, blocks);
  sr.locked = true;
  await answer("/diff", diff);
  await open;
  assert.equal(opened.length, 0);
});

test("a read that fails after the owner moved on shows no error over the newer page", async (t) => {
  const { page, sr, opened, fail } = await reviewPage(t);
  const open = page.openSourceReview(waiting, blocks);
  sr.S.view = "chat";
  await fail("/diff", new Error("The engine is not answering"));
  await open;
  assert.equal(opened.length, 0);
  assert.deepEqual(sr.toasts, []);
});

test("a dialog opened and closed with Escape while the draft was read still counts: the late review does not open", async (t) => {
  const { page, sr, opened, answer, escape } = await reviewPage(t);
  const open = page.openSourceReview(approved, blocks);
  sr.dlg = { other: true };
  escape();
  sr.dlg = null;
  await answer("/draft", draft);
  await open;
  assert.equal(opened.length, 0);
});
