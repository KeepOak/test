/* CHAT: the chat app wizard opens, and redraws after a read, only for what asked for it. If the App lock came on, the
   owner moved to another page, or a newer open started while the app's setup, health or lock state was being read, the
   late answer is dropped: no wizard, no error and no Save step drawn over the lock or the newer page.
   The real public/app/flows/chat.js runs in Node next to stand-ins for the window's core modules; each read is held open
   by the test, so the change happens while the wizard is waiting, with no timers.
   Mutations: drop unlocked() from opening() -> the lock cases fail; drop `S.view === view` -> the page case fails; drop
   the check after the setup read -> the first lock and page cases fail; drop unlocked() or the view from currentWizard ->
   the Save step cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const $ = () => null; export const esc = (s) => String(s ?? \"\");",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__cw.openDlg(o); export const closeDlg = () => {};
    export const toast = (m) => globalThis.__cw.toasts.push(m); export const ic = () => "";`,
  "app/core/state.js": `export const S = globalThis.__cw.S; export const E = {}; export const refresh = async () => {};
    export const ownerHere = () => globalThis.__cw.owner; export const activeId = () => globalThis.__cw.profile;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__cw.api(path, body);",
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
  const held = [], opened = [];
  const cw = { S: { view: "customize" }, owner: true, profile: null, locked: false, toasts: [], acts: {},
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })),
    openDlg: (o) => { opened.push(o); return { isConnected: true }; } };
  globalThis.__cw = cw;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && cw.locked } } : null),
    addEventListener: () => {} };
  t.after(async () => { delete globalThis.__cw; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "flows", "chat.js")).href);
  page.init();
  const asked = async (path) => { for (let i = 0; i < 50 && !held.some((h) => h.path === path); i++) await Promise.resolve(); };
  const settle = async (path, how, value) => {
    await asked(path);
    const at = held.findIndex((h) => h.path === path);
    assert.ok(at >= 0, `the wizard asked for ${path} (waiting: ${held.map((h) => h.path).join(", ")})`);
    held.splice(at, 1)[0][how](value);
  };
  return { page, cw, opened, asked, answer: (path, value) => settle(path, "resolve", value), fail: (path, error) => settle(path, "reject", error) };
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
