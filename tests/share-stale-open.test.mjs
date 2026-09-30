/* CHAT: Share… reads the owner's sign-in card and the chats a conversation can be handed off to before it opens, and Hand
   off waits for the engine's answer. A late answer opens or draws nothing, and shows no error, if meanwhile the App lock
   came on, the owner switched person or page, another dialog was opened, replaced or closed, or a newer Share started.
   The real public/app/flows/share.js runs in Node next to stand-ins for the window's core modules; each read is held
   open by the test, so the change happens while it waits, with no timers.
   Mutations: drop unlocked() -> the lock cases fail; drop `dialog() === opened` -> the other-dialog cases fail; drop the
   close/Escape count -> the closed cases fail; drop `S.view === view` -> the page case fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\");",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__sh.openDlg(o); export const closePop = () => {};
    export const toast = (m) => globalThis.__sh.toasts.push(m); export const mi = () => ""; export const ic = () => "";
    export const dialog = () => globalThis.__sh.dlg;`,
  "app/core/state.js": `export const S = globalThis.__sh.S; export const E = globalThis.__sh.E;
    export const ownerHere = () => globalThis.__sh.owner; export const activeId = () => globalThis.__sh.profile;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__sh.api(path, body); export const isDesktop = false;",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__sh.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/logos.js": "export const logo = () => \"\";",
  "app/core/words.js": "export const say = (s) => s;", // newer share.js says its download line through say()
  "app/settings/parts.js": "export const ctlSeg = () => \"\";",
  "app/places/team-tabs.js": "export const peopleRows = () => \"\"; export const relate = async () => null;",
  "i18n.js": "export const t = (key) => key;",
};

async function sharePage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-share-stale-"));
  for (const dir of ["app/flows", "app/core", "app/settings", "app/places"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "flows", "share.js"), await readFile(new URL("../public/app/flows/share.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [], opened = [], listeners = [];
  const sh = { S: { view: "chat", chat: "s1" }, E: { trunks: [], sessions: [{ id: "s1", title: "Plans" }] }, owner: true, profile: null,
    locked: false, toasts: [], acts: {}, dlg: null,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })),
    openDlg: (o) => { opened.push(o); sh.dlg = { share: o, isConnected: true }; return sh.dlg; } };
  globalThis.__sh = sh;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && sh.locked } } : null),
    addEventListener: (type, fn, capture) => { if (capture) listeners.push({ type, fn }); } };
  t.after(async () => { delete globalThis.__sh; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "flows", "share.js")).href);
  page.init();
  const settle = async (path, how, value) => {
    for (let i = 0; i < 50 && !held.some((h) => h.path === path); i++) await Promise.resolve();
    const at = held.findIndex((h) => h.path === path);
    assert.ok(at >= 0, `asked for ${path}`);
    held.splice(at, 1)[0][how](value);
  };
  const fire = (type, event) => { for (const one of listeners) if (one.type === type) one.fn(event); };
  return { sh, opened, answer: (path, value) => settle(path, "resolve", value), fail: (path, error) => settle(path, "reject", error),
    open: () => sh.acts.share10({ dataset: { k: "conv" } }),
    closeButton: () => { fire("click", { target: { closest: (q) => (q.includes("dlg-close") ? {} : null) } }); sh.dlg = null; },
    escape: () => { fire("keydown", { key: "Escape" }); sh.dlg = null; } };
}
const reads = async (w) => { await w.answer("people/settings", { people: [] }); await w.answer("channels", { handoffTargets: [] }); };

test("with nothing changed, Share opens once its reads are answered", async (t) => {
  const w = await sharePage(t);
  const open = w.open();
  await reads(w);
  await open;
  assert.equal(w.opened.length, 1);
});

const LATE = [
  ["the App lock came on", (w) => { w.sh.locked = true; }],
  ["another person's profile was switched to", (w) => { w.sh.profile = "p-2"; }],
  ["the owner moved to another page", (w) => { w.sh.S.view = "customize"; }],
  ["another dialog was opened", (w) => { w.sh.dlg = { other: true, isConnected: true }; }],
  ["a dialog was opened and closed with Escape", (w) => { w.sh.dlg = { other: true, isConnected: true }; w.escape(); }],
  ["a newer Share started", (w) => { void w.open(); }],
];
for (const [what, change] of LATE) {
  test(`${what} while Share was read: the late Share does not open`, async (t) => {
    const w = await sharePage(t);
    const open = w.open();
    change(w);
    await reads(w);
    await open;
    assert.equal(w.opened.length, 0);
  });
}

test("a dialog closed with its close button while Share was read: the late Share does not open", async (t) => {
  const w = await sharePage(t);
  w.sh.dlg = { other: true, isConnected: true };
  const open = w.open();
  w.closeButton();
  await reads(w);
  await open;
  assert.equal(w.opened.length, 0);
});

test("a Share read that fails behind the lock shows no error over it", async (t) => {
  const w = await sharePage(t);
  const open = w.open();
  w.sh.locked = true;
  await w.fail("people/settings", new Error("The engine is not answering"));
  await open;
  assert.deepEqual(w.sh.toasts, []);
});

test("the App lock came on while Hand off was answered: nothing is drawn or said over the lock", async (t) => {
  const w = await sharePage(t);
  const open = w.open();
  await reads(w);
  await open;
  w.sh.acts["share-tab"]({ dataset: { v: "handoff" } });
  const drawn = w.opened.length, button = { dataset: { v: "terminal" }, disabled: false, isConnected: true };
  const handing = w.sh.acts["share-handoff"](button);
  w.sh.locked = true;
  await w.answer("commands/run", { handled: true, text: "Run: branch resume s1" });
  await handing;
  assert.equal(w.opened.length, drawn, "nothing was drawn after the lock");
  const again = w.sh.acts["share-handoff"](button);
  await again;
  assert.deepEqual(w.sh.toasts, []);
});
