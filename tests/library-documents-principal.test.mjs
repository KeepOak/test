/* Library › Documents shows the owner's documents only to the owner at an unlocked window. The list read from
   GET /api/documents is kept for the owner it was read for: a read that comes back after the window switched to a
   household person, or after the App lock came on, or after the owner left the page, draws nothing and keeps nothing,
   and a list already kept is never drawn for anyone else, or over the lock.
   The real public/app/places/library.js runs in Node next to stand-ins for the window's modules; each read is held
   open by the test, so the change happens while the page is waiting, with no timers.
   Mutations: drop the check after the documents read -> the switch, lock and page cases fail; drop the principal
   the kept list belongs to (or the lock) from what documentsTab draws -> the kept-list cases fail. */
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
    export const openPop = () => {}; export const closePop = () => {}; export const openDlg = () => {}; export const closeDlg = () => {}; export const dialog = () => null;`,
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/api.js": "export const api = (path, body) => globalThis.__lb.api(path, body); export const token = { get: () => \"\" };",
  "app/core/actions.js": "export const on = () => {};",
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
    locked: false, renders: 0, toasts: [], api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })) };
  globalThis.__lb = lb;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && lb.locked } } : null),
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
  return { page, lb, read };
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
  assert.doesNotMatch(page.draw(), /Kettle notes|Tax 2026/, "nothing of the owner's drawn for Sam");
  lb.E.profiles = owner;
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
