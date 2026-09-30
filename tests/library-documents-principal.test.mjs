/* Library › Documents shows the owner's documents only to the owner at an unlocked window. The list read from
   GET /api/documents is kept for the owner it was read for: a read that comes back after the window switched to a
   household person, or after the App lock came on, or after the owner left the page, draws nothing and keeps nothing,
   and a list already kept is never drawn for anyone else, or over the lock.
   The real public/app/places/library.js runs in Node next to stand-ins for the window's modules; each read is held
   open by the test, so the change happens while the page is waiting, with no timers.
   "Write a new document" is kept the same way: a save closes only the dialog it came from, and says nothing (kept, or
   the engine's refusal) once that dialog was closed or replaced, the window switched to someone else, or it locked.
   Mutations: drop the check after the documents read -> the switch, lock and page cases fail; drop the principal
   the kept list belongs to (or the lock) from what documentsTab draws -> the kept-list cases fail; drop the save's
   check after its POST -> the save cases (other than the unchanged ones) fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const renderNow = () => { globalThis.__lb.renders += 1; };",
  "app/core/state.js": "export const S = globalThis.__lb.S; export const E = globalThis.__lb.E; export const refresh = async () => {}; export const level = () => 0;",
  "app/core/ui.js": `export const ic = () => ""; export const mi = () => ""; export const toast = (m) => globalThis.__lb.toasts.push(m);
    export const openPop = () => {}; export const closePop = () => {}; export const dialog = () => globalThis.__lb.dlg;
    export const openDlg = (o) => { globalThis.__lb.dlg = { title: o.title }; return globalThis.__lb.dlg; };
    export const closeDlg = () => { globalThis.__lb.dlg = null; };`,
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/api.js": "export const api = (path, body) => globalThis.__lb.api(path, body); export const token = { get: () => \"\" };",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__lb.acts[name] = fn; };",
  "app/chat/markdown.js": "export const inlineText = (s) => String(s ?? \"\");",
  "app/places/library17.js": `export const workSection = () => ""; export const labelled = (docs) => docs; export const mapSection = () => "";
    export const manageSection = () => ""; export const learnSection = () => ""; export const readLibrary17 = async () => ({ changed: false });
    export const initLibrary17 = () => {};`,
  "app/places/inbox17.js": "export const nameOf = () => \"\";",
  "i18n.js": "export const t = (key) => key; export const language = () => \"en\"; export const plural = () => \"\";",
  "app/core/words.js": "export const say = (s) => s;",
  "app/core/p18.js": "export const empty18 = (k) => `<empty ${k}>`;",
  "app/places/docread.js": "export const initDocRead = () => {}; export const revealable = () => false;",
  "app/places/memory-review.js": "export const pendingMemories = () => \"\"; export const readPendingMemories = async () => {}; export const initMemoryReview = () => {};",
  "app/places/memory-detail.js": "export const initMemoryDetail = () => {};",
  "app/chat/approvals.js": "export const lockdownOn = () => false;",
};
const owner = { active: null, isOwner: true };
const sam = { active: { id: "sam" }, isOwner: false };
const doc = (name) => ({ id: `id-${name}`, name, updatedAt: "2026-09-30T10:00:00.000Z", addedBy: { kind: "person", name: "Ada", role: "owner" } });

async function libraryPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-library-docs-"));
  for (const dir of ["app/places", "app/core", "app/chat"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "places", "library.js"), await readFile(new URL("../public/app/places/library.js", import.meta.url)));
  /* The window's own sessionPrincipal, taken from core/session-pages.js (the rest of that module needs a real window). */
  const pages = await readFile(new URL("../public/app/core/session-pages.js", import.meta.url), "utf8");
  const principal = /^export const sessionPrincipal = .*$/m.exec(pages)?.[0];
  assert.ok(principal, "core/session-pages.js still says who the window is for");
  await writeFile(join(root, "app", "core", "session-pages.js"), principal);
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const lb = { S: { view: "library", tabs: { library: "documents" } }, E: { state: { memory: [] }, profiles: owner },
    locked: false, renders: 0, toasts: [], acts: {}, dlg: null, fields: { "doc-new-name": "Plan", "doc-new-text": "The plan." }, api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })) };
  globalThis.__lb = lb;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && lb.locked } }
    : id in lb.fields ? { value: lb.fields[id] } : null),
    addEventListener: () => {} };
  t.after(async () => { delete globalThis.__lb; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "places", "library.js")).href);
  /** Starts the Documents tab's read and hands back a way to answer it once it is asked for. */
  const read = async () => {
    const done = page.after();
    for (let i = 0; i < 50 && !held.some((h) => h.path === "documents"); i++) await Promise.resolve();
    const at = held.findIndex((h) => h.path === "documents");
    assert.ok(at >= 0, "the Documents tab asked for its documents");
    const one = held.splice(at, 1)[0];
    return async (documents) => { one.resolve({ documents }); await done; };
  };
  /** Opens "Write a new document", presses Keep, and hands back the held POST and a way to see what else was asked. */
  const save = async () => {
    lb.acts["doc-new"]();
    const opened = lb.dlg;
    const done = lb.acts["doc-new-save"]();
    for (let i = 0; i < 50 && !held.some((h) => h.path === "documents" && h.body); i++) await Promise.resolve();
    const at = held.findIndex((h) => h.path === "documents" && h.body);
    assert.ok(at >= 0, "the save sent the document");
    const reread = () => held.findIndex((h) => h.path === "documents" && !h.body);
    /* Lets the save run to its end, answering any read of the list it asks for; says whether it asked for one. */
    const finish = async () => {
      let asked = false;
      for (let i = 0; i < 50; i++) { const r = reread(); if (r >= 0) { asked = true; held.splice(r, 1)[0].resolve({ documents: [] }); } await Promise.resolve(); }
      await done;
      return asked;
    };
    return { opened, done, finish, post: held.splice(at, 1)[0], reread };
  };
  page.init();
  return { page, lb, read, save, held };
}

test("with nothing changed, the owner's documents are drawn once they are read", async (t) => {
  const { page, lb, read } = await libraryPage(t);
  await (await read())([doc("Kettle notes.md")]);
  assert.equal(lb.renders, 1);
  assert.match(page.draw(), /Kettle notes\.md/);
});

test("the window switched to a household person during the read: nothing drawn, and the kept list is let go", async (t) => {
  const { page, lb, read } = await libraryPage(t);
  await (await read())([doc("Kettle notes.md")]);
  const renders = lb.renders;
  const answer = await read();
  lb.E.profiles = sam;
  await answer([doc("Kettle notes.md"), doc("Tax 2026.pdf")]);
  assert.equal(lb.renders, renders, "no render for the late answer");
  lb.E.profiles = owner; // back before anything is drawn: the late answer itself let the kept list go
  assert.doesNotMatch(page.draw(), /Kettle notes|Tax 2026/, "the owner's earlier list was let go, not kept for later");
});

test("the App lock came on during the read: nothing drawn, and nothing kept", async (t) => {
  const { page, lb, read } = await libraryPage(t);
  const answer = await read();
  lb.locked = true;
  await answer([doc("Kettle notes.md")]);
  assert.equal(lb.renders, 0, "no render over the lock");
  assert.doesNotMatch(page.draw(), /Kettle notes/);
  lb.locked = false;
  assert.doesNotMatch(page.draw(), /Kettle notes/, "the late answer was not kept");
});

test("the owner left the Documents tab during the read: the late answer is not drawn", async (t) => {
  const { lb, read } = await libraryPage(t);
  const answer = await read();
  lb.S.tabs.library = "memory";
  await answer([doc("Kettle notes.md")]);
  assert.equal(lb.renders, 0);
});

test("a kept list is not drawn once the window switches to a household person", async (t) => {
  const { page, lb, read } = await libraryPage(t);
  await (await read())([doc("Kettle notes.md")]);
  lb.E.profiles = sam;
  assert.doesNotMatch(page.draw(), /Kettle notes/, "not drawn for Sam");
  lb.E.profiles = owner;
  assert.doesNotMatch(page.draw(), /Kettle notes/, "let go on the switch; the owner's next read draws it again");
});

test("a kept list is not drawn while the App lock is on", async (t) => {
  const { page, lb, read } = await libraryPage(t);
  await (await read())([doc("Kettle notes.md")]);
  lb.locked = true;
  assert.doesNotMatch(page.draw(), /Kettle notes/);
});

test("a save with nothing changed closes its dialog, reads the list again and says it was kept", async (t) => {
  const { page, lb, save, held } = await libraryPage(t);
  const { opened, done, post, reread } = await save();
  assert.ok(opened, "the dialog opened");
  post.resolve({ id: "id-Plan.md" });
  for (let i = 0; i < 50 && reread() < 0; i++) await Promise.resolve();
  assert.equal(lb.dlg, null, "its dialog closed");
  held.splice(reread(), 1)[0].resolve({ documents: [doc("Plan.md")] });
  await done;
  assert.deepEqual(lb.toasts, ["window.places.library.doc-kept"]);
  assert.match(page.draw(), /Plan\.md/);
});

test("the owner closed the dialog while the document was being kept: nothing more is said or read", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { finish, post } = await save();
  lb.dlg = null; // the close button, or Escape
  post.resolve({ id: "id-Plan.md" });
  const reread = await finish();
  assert.deepEqual(lb.toasts, []);
  assert.equal(reread, false, "no read of the list for a save nobody is waiting on");
  assert.equal(lb.renders, 0);
});

test("another dialog replaced it while the document was being kept: the newer dialog stays open", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { finish, post } = await save();
  const newer = { title: "another" };
  lb.dlg = newer;
  post.resolve({ id: "id-Plan.md" });
  await finish();
  assert.equal(lb.dlg, newer, "the newer dialog was not closed");
  assert.deepEqual(lb.toasts, []);
});

test("the window switched to a household person while the document was being kept: nothing closed, said or read", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { opened, finish, post } = await save();
  lb.E.profiles = sam;
  post.resolve({ id: "id-Plan.md" });
  const reread = await finish();
  assert.equal(lb.dlg, opened, "not closed for someone else");
  assert.deepEqual(lb.toasts, []);
  assert.equal(reread, false);
});

test("the App lock came on while the document was being kept: nothing closed, said or read", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { opened, finish, post } = await save();
  lb.locked = true;
  post.resolve({ id: "id-Plan.md" });
  const reread = await finish();
  assert.equal(lb.dlg, opened);
  assert.deepEqual(lb.toasts, []);
  assert.equal(reread, false);
});

test("a refused save still says why to the owner who is waiting on it", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { opened, done, post } = await save();
  post.reject(new Error("That file came through empty"));
  await done;
  assert.deepEqual(lb.toasts, ["That file came through empty"]);
  assert.equal(lb.dlg, opened, "left open to try again");
});

test("a refused save that answers after the window switched to a household person says nothing to them", async (t) => {
  const { lb, save } = await libraryPage(t);
  const { done, post } = await save();
  lb.E.profiles = sam;
  post.reject(new Error("Adding a document belongs to the owner."));
  await done;
  assert.deepEqual(lb.toasts, []);
});

test("the window switched to a household person while the list was read again: no word, no render, nothing kept", async (t) => {
  const { page, lb, save, held } = await libraryPage(t);
  const { done, post, reread } = await save();
  post.resolve({ id: "id-Plan.md" });
  for (let i = 0; i < 50 && reread() < 0; i++) await Promise.resolve();
  assert.ok(reread() >= 0, "the list was read again");
  lb.E.profiles = sam;
  held.splice(reread(), 1)[0].resolve({ documents: [doc("Plan.md")] });
  await done;
  assert.deepEqual(lb.toasts, []);
  assert.equal(lb.renders, 0);
  lb.E.profiles = owner;
  assert.doesNotMatch(page.draw(), /Plan\.md/, "the late list was not kept");
});
