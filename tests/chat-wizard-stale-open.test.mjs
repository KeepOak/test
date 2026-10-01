/* CHAT: the chat app wizard opens, and redraws after a read, only for what asked for it. If the App lock came on, the
   owner moved to another page, or a newer open started while the app's setup, health or lock state was being read, the
   late answer is dropped: no wizard, no error and no Save step drawn over the lock or the newer page.
   The real public/app/flows/chat.js runs in Node next to stand-ins for the window's core modules; each read is held open
   by the test, so the change happens while the wizard is waiting, with no timers.
   Mutations: drop `dialog() === opened` -> the newer-dialog cases fail; drop the close/Escape count -> the closed-dialog
   cases fail; drop unlocked() from opening() -> the lock cases fail; drop `S.view === view` -> the page case fails; drop
   the check after the setup read -> the first lock and page cases fail; drop unlocked() or the view from currentWizard ->
   the Save step cases fail; drop the currentWizard checks in remove() -> the Remove cases fail; drop the closeWizard()
   check after the refresh -> the late-toast cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const $ = () => null; export const esc = (s) => String(s ?? \"\");",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__cw.openDlg(o); export const closeDlg = () => { globalThis.__cw.closed++; if (globalThis.__cw.dlg) globalThis.__cw.dlg.isConnected = false; globalThis.__cw.dlg = null; };
    export const dialog = () => globalThis.__cw.dlg; export const toast = (m) => globalThis.__cw.toasts.push(m); export const ic = () => "";`,
  "app/core/state.js": `export const S = globalThis.__cw.S; export const E = {}; export const refresh = () => globalThis.__cw.refresh();
    export const ownerHere = () => globalThis.__cw.owner; export const activeId = () => globalThis.__cw.profile;`,
  "app/core/api.js": "export const api = (path, body, method) => globalThis.__cw.api(path, body, method);",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__cw.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/logos.js": "export const logo = () => \"\";",
  "app/core/qr.js": "export const qr = () => \"\";",
  "app/flows/chatapps17d.js": "export const manage17d = () => \"\"; export const fixNote17d = () => \"\";",
  "i18n.js": "export const t = (key) => key;",
};

async function wizardPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-wizard-"));
  for (const dir of ["app/flows", "app/core"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "flows", "chat.js"), await readFile(new URL("../public/app/flows/chat.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [], opened = [], listeners = [];
  const cw = { S: { view: "customize" }, owner: true, profile: null, locked: false, toasts: [], acts: {}, dlg: null, closed: 0,
    api: (path, body, method = body === undefined ? "GET" : "POST") => new Promise((resolve, reject) => held.push({ path, body, method, resolve, reject })),
    /* The page's refresh after the wizard closes, held open like a read so the test can change things meanwhile. */
    refresh: () => new Promise((resolve, reject) => held.push({ path: "refresh", method: "GET", resolve, reject })),
    /* As the window's dialogs: a new one replaces (disconnects) the one open. */
    openDlg: (o) => { opened.push(o); if (cw.dlg) cw.dlg.isConnected = false; cw.dlg = { wizard: o, isConnected: true }; return cw.dlg; } };
  globalThis.__cw = cw;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && cw.locked } } : null),
    addEventListener: (type, fn, capture) => { if (capture) listeners.push({ type, fn }); } };
  t.after(async () => { delete globalThis.__cw; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "flows", "chat.js")).href);
  page.init();
  const matches = (h, path) => h.path === path || `${h.method} ${h.path}` === path;
  const asked = async (path) => { for (let i = 0; i < 50 && !held.some((h) => matches(h, path)); i++) await Promise.resolve(); };
  const settle = async (path, how, value) => {
    await asked(path);
    const at = held.findIndex((h) => matches(h, path));
    assert.ok(at >= 0, `the wizard asked for ${path} (waiting: ${held.map((h) => h.path).join(", ")})`);
    held.splice(at, 1)[0][how](value);
  };
  /* The owner closes the open dialog with its close button, or with Escape (main.js closes it after this module hears it). */
  const fire = (type, event) => { for (const one of listeners) if (one.type === type) one.fn(event); };
  const gone = () => { if (cw.dlg) cw.dlg.isConnected = false; cw.dlg = null; };
  const closeButton = () => { fire("click", { target: { closest: (q) => (q.includes("dlg-close") ? {} : null) } }); gone(); };
  const escape = () => { fire("keydown", { key: "Escape" }); gone(); };
  /* Answers whatever is still waiting, so a step that should not have run cannot leave the test hanging. */
  const drain = async () => { for (let i = 0; i < 100; i++) { while (held.length) held.shift().resolve({}); await Promise.resolve(); } };
  return { page, cw, opened, asked, closeButton, escape, drain, answer: (path, value) => settle(path, "resolve", value), fail: (path, error) => settle(path, "reject", error) };
}

/* A Telegram-like recipe with a Create step, so Continue goes on to Save, which reads the direct-message choices. */
const recipe = { id: "telegram", name: "Telegram", create: { url: "https://t.me/BotFather" } };
const channels = (over = {}) => ({ channels: [], ownerNamed: true, dmPolicyChoices: [], ...over });

test("with nothing changed, the wizard opens once the setup and the apps are read", async (t) => {
  const { page, cw, opened, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 1);
  assert.equal(cw.S.chw?.id, "telegram");
});

test("the App lock came on while the setup was read: no wizard over the lock", async (t) => {
  const { page, cw, opened, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  cw.locked = true;
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
  assert.equal(cw.S.chw, undefined, "no wizard state was kept for later either");
});

test("the owner moved to another page while the setup was read: the wizard does not open there", async (t) => {
  const { page, cw, opened, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  cw.S.view = "chat";
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
});

test("the App lock came on while the lock state was read: no wizard over the lock", async (t) => {
  const { page, cw, opened, asked, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels({ ownerNamed: false }));
  await asked("lock");
  cw.locked = true;
  await answer("lock", { pinSet: true });
  await open;
  assert.equal(opened.length, 0);
});

test("a setup read that fails behind the lock shows no error over it", async (t) => {
  const { page, cw, opened, answer, fail } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  cw.locked = true;
  await fail("channel-setup/telegram", new Error("The engine is not answering"));
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
  assert.deepEqual(cw.toasts, []);
});

for (const [what, change] of [["the App lock came on", (cw) => { cw.locked = true; }], ["the owner moved to another page", (cw) => { cw.S.view = "chat"; }]]) {
  test(`${what} while Save read the direct-message choices: the Save step is not drawn`, async (t) => {
    const { page, cw, opened, answer } = await wizardPage(t);
    const open = page.openChatWizard("telegram");
    await answer("channel-setup/telegram", recipe);
    await answer("channels", channels());
    await open;
    assert.equal(opened.length, 1, "the wizard opened at Create");
    const next = cw.acts["chw-next"]();
    change(cw);
    await answer("channels", channels({ dmPolicyChoices: [{ channel: "telegram", policy: "owner", ownerEligible: true }] }));
    await next;
    assert.equal(opened.length, 1, "nothing was drawn after the change");
  });
}

test("an unrelated dialog opened on the same page while the setup was read is not replaced by the late wizard", async (t) => {
  const { page, cw, opened, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  const newer = { newer: true, isConnected: true };
  cw.dlg = newer;
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
  assert.equal(cw.dlg, newer, "the newer dialog is still the one open");
});

test("an unrelated dialog opened while the lock state was read is not replaced either", async (t) => {
  const { page, cw, opened, asked, answer } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels({ ownerNamed: false }));
  await asked("lock");
  cw.dlg = { newer: true, isConnected: true };
  await answer("lock", { pinSet: true });
  await open;
  assert.equal(opened.length, 0);
});

test("a dialog the owner closed with its close button while the setup was read: the late wizard does not open", async (t) => {
  const { page, cw, opened, answer, closeButton } = await wizardPage(t);
  cw.dlg = { other: true, isConnected: true };
  const open = page.openChatWizard("telegram");
  closeButton();
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
});

test("a dialog opened and closed with Escape while the setup was read still counts: the late wizard does not open", async (t) => {
  const { page, cw, opened, answer, escape } = await wizardPage(t);
  const open = page.openChatWizard("telegram");
  cw.dlg = { other: true, isConnected: true };
  escape();
  await answer("channel-setup/telegram", recipe);
  await answer("channels", channels());
  await open;
  assert.equal(opened.length, 0);
});

/* Remove disconnects the app, then closes its wizard: only if that wizard is still the one open, unlocked, on its page. */
async function openedWizard(t) {
  const world = await wizardPage(t);
  const open = world.page.openChatWizard("telegram");
  await world.answer("channel-setup/telegram", recipe);
  await world.answer("channels", channels());
  await open;
  return world;
}

test("Remove with nothing changed closes the wizard and says the app was removed", async (t) => {
  const { cw, answer } = await openedWizard(t);
  const removing = cw.acts["chw-remove"]();
  await answer("DELETE channel-setup/telegram", {});
  await answer("refresh");
  await removing;
  assert.equal(cw.closed, 1);
  assert.equal(cw.S.chw, null);
  assert.deepEqual(cw.toasts, ["window.flows.chw.removed"]);
});

test("a newer wizard opened while Remove was answered is not closed by the late answer", async (t) => {
  const { page, cw, answer, drain } = await openedWizard(t);
  const removing = cw.acts["chw-remove"]();
  const newer = page.openChatWizard("telegram");
  await answer("GET channel-setup/telegram", recipe);
  await answer("channels", channels());
  await newer;
  const current = cw.S.chw;
  await answer("DELETE channel-setup/telegram", {});
  await drain();
  await removing;
  assert.equal(cw.closed, 0, "the newer wizard's dialog stayed open");
  assert.equal(cw.S.chw, current, "the newer wizard is still the one open");
});

test("the App lock came on while Remove was answered: nothing is closed or said over the lock", async (t) => {
  const { cw, answer, drain } = await openedWizard(t);
  const removing = cw.acts["chw-remove"]();
  cw.locked = true;
  await answer("DELETE channel-setup/telegram", {});
  await drain();
  await removing;
  assert.equal(cw.closed, 0);
  assert.deepEqual(cw.toasts, []);
});

test("a Remove that fails after the owner moved to another page shows no error there", async (t) => {
  const { cw, fail } = await openedWizard(t);
  const removing = cw.acts["chw-remove"]();
  cw.S.view = "chat";
  await fail("DELETE channel-setup/telegram", new Error("The engine is not answering"));
  await removing;
  assert.deepEqual(cw.toasts, []);
});

/* After Remove or Save the wizard closes and the page is read again; the toast after that read shows only if nothing
   newer happened while it was read. The refresh is held open here, and the window changes meanwhile. */
const LATE = [
  ["the App lock came on", (w) => { w.cw.locked = true; }],
  ["the owner moved to another page", (w) => { w.cw.S.view = "chat"; }],
  ["another person's profile was switched to", (w) => { w.cw.profile = "p-2"; }],
  ["another dialog was opened", (w) => { w.cw.dlg = { other: true, isConnected: true }; }],
  ["a newer wizard was started", (w) => { void w.page.openChatWizard("telegram"); }],
];
for (const [act, trigger, done] of [["Remove", "chw-remove", (w) => w.answer("DELETE channel-setup/telegram", {})], ["Save", "chw-save", async () => {}]]) {
  test(`${act} with nothing changed during the page's refresh says what happened once it is read`, async (t) => {
    const world = await openedWizard(t);
    const acting = world.cw.acts[trigger]();
    await done(world);
    await world.answer("refresh");
    await acting;
    assert.equal(world.cw.toasts.length, 1);
  });
  for (const [what, change] of LATE) {
    test(`${what} during the page's refresh after ${act}: the late toast is not shown`, async (t) => {
      const world = await openedWizard(t);
      const acting = world.cw.acts[trigger]();
      await done(world);
      await world.asked("refresh");
      change(world);
      await world.answer("refresh");
      await acting;
      assert.deepEqual(world.cw.toasts, []);
    });
  }
}

/* Remove's success closes its own wizard, never a dialog opened after the wizard was left with Escape. */
test("the wizard was left with Escape and another dialog opened while Remove was answered: that dialog stays open", async (t) => {
  const { cw, answer, escape, drain } = await openedWizard(t);
  const removing = cw.acts["chw-remove"]();
  escape();
  const replacement = { other: true, isConnected: true };
  cw.dlg = replacement;
  await answer("DELETE channel-setup/telegram", {});
  await drain();
  await removing;
  assert.equal(cw.dlg, replacement, "the replacement dialog is still open");
  assert.equal(cw.closed, 0);
  assert.deepEqual(cw.toasts, []);
});
