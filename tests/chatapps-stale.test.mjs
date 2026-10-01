/* Settings › Chat apps and the Inbox's "Telegram refuses its token" card. The page's reads, and "Turn Telegram off" with
   its Undo, act on a late answer only for the owner who asked, unlocked, on the same page: a lock during the card's read
   sends no switch at all, and no error, redraw or note shows behind the lock, for another person, or on another page.
   The real public/app/settings/pages/chatapps.js runs in Node next to stand-ins for the window's modules; each read is
   held open by the test, so the change happens while it waits, with no timers.
   Mutations: drop the check before the off POST -> "no switch is sent" fails; drop sameOwner() in loadApps -> the page
   read cases fail; drop still() after loadApps() in turnTelegramOff -> the late-note cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const nothing = "export const initOwnerCommands = () => {}; export const ownerCommandCard = () => \"\";";
const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const render = () => { globalThis.__ca.renders++; };",
  "app/core/state.js": `export const level = () => 1; export const S = globalThis.__ca.S; export const E = globalThis.__ca.E;
    export const ownerHere = () => globalThis.__ca.owner; export const activeId = () => globalThis.__ca.profile;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__ca.api(path, body);",
  "app/core/ui.js": "export const toast = (m, undo) => globalThis.__ca.toasts.push(m); export const openDlg = () => {};",
  "app/core/logos.js": "export const logo = () => \"\";",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__ca.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/settings/owner-commands.js": nothing,
  "app/settings/chat-steps.js": "export const stepsCard = () => \"\"; export const initSteps = () => {};",
  "app/settings/phone-access.js": "export const phoneAccessCard = () => \"\"; export const initPhoneAccess = () => {}; export const loadPhoneAccess = async () => {};",
  "app/settings/rows15.js": "export const sw15 = () => \"\"; export const sec15 = () => \"\"; export const seg15 = () => \"\"; export const id15 = (s) => s;",
  "app/flows/chatapps17d.js": "export const nativeFormat = () => \"\"; export const pill17d = () => \"\"; export const stateOf = () => [];",
  "app/settings/chat-formatting.js": "export const formatButtons = () => \"\"; export const initFormatting = () => {}; export const loadFormats = async () => {};",
  "app/settings/chat-reply-style.js": "export const initReplyStyle = () => {}; export const loadReplyStyles = async () => {}; export const replyStyleRows = () => \"\";",
  "i18n.js": "export const t = (key) => key;",
};

async function appsPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chatapps-stale-"));
  for (const dir of ["app/settings/pages", "app/core", "app/flows"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "settings", "pages", "chatapps.js"), await readFile(new URL("../public/app/settings/pages/chatapps.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const ca = { S: { view: "inbox" }, E: { profiles: { isOwner: true } }, owner: true, profile: null, locked: false, toasts: [], acts: {}, renders: 0,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, method: body === undefined ? "GET" : "POST", body, resolve, reject })) };
  globalThis.__ca = ca;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && ca.locked } } : null),
    addEventListener: () => {} };
  t.after(async () => { delete globalThis.__ca; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "settings", "pages", "chatapps.js")).href);
  page.init();
  const matches = (h, path) => h.path === path || `${h.method} ${h.path}` === path;
  const asked = async (path) => { for (let i = 0; i < 50 && !held.some((h) => matches(h, path)); i++) await Promise.resolve(); };
  const settle = async (path, how, value) => {
    await asked(path);
    const at = held.findIndex((h) => matches(h, path));
    assert.ok(at >= 0, `asked for ${path}`);
    held.splice(at, 1)[0][how](value);
  };
  /* Answers whatever is still waiting, so a step that should not have been asked for cannot leave the test hanging. */
  const drain = async () => { for (let i = 0; i < 100; i++) { while (held.length) held.shift().resolve({}); await Promise.resolve(); } };
  return { page, ca, held, asked, drain, answer: (path, value) => settle(path, "resolve", value), fail: (path, error) => settle(path, "reject", error) };
}
const telegram = { channels: [{ id: "telegram", kind: "telegram", health: { state: "needs attention", reason: "refused" } }] };
const card = { card: { channel: "telegram", revision: 3 }, mode: "on", settingsRevision: 7 };
/* The page's own reads answered, so the Inbox card is drawn and the page is idle. */
async function loaded(w) {
  w.page.revokedPrompts();
  await w.answer("channels", telegram);
  await w.answer("channel-setup", { channels: [] });
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const offButton = () => ({ dataset: { v: "telegram" }, isConnected: true });

test("with nothing changed, the page is drawn and Turn Telegram off shows its note after the page is read again", async (t) => {
  const w = await appsPage(t);
  await loaded(w);
  assert.equal(w.ca.renders, 1);
  const off = w.ca.acts.revoff17d(offButton());
  await w.answer("GET never-break/telegram", card);
  await w.answer("POST never-break/telegram", { note: "Telegram is off", receipt: "r1" });
  await w.answer("channels", telegram);
  await w.answer("channel-setup", { channels: [] });
  await off;
  assert.deepEqual(w.ca.toasts, ["Telegram is off"]);
});

test("the App lock came on while Telegram's card was read: no switch is sent", async (t) => {
  const w = await appsPage(t);
  await loaded(w);
  const off = w.ca.acts.revoff17d(offButton());
  w.ca.locked = true;
  await w.answer("GET never-break/telegram", card);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const sent = w.held.some((h) => h.method === "POST");
  await w.drain();
  await off;
  assert.equal(sent, false, "Telegram was not switched off behind the lock");
  assert.deepEqual(w.ca.toasts, []);
});

const LATE = [
  ["the App lock came on", (ca) => { ca.locked = true; }],
  ["another person's profile was switched to", (ca) => { ca.profile = "p-2"; }],
  ["the owner moved to another page", (ca) => { ca.S.view = "chat"; }],
];
for (const [what, change] of LATE) {
  test(`${what} while the page was read again after Turn Telegram off: its note is not shown`, async (t) => {
    const w = await appsPage(t);
    await loaded(w);
    const off = w.ca.acts.revoff17d(offButton());
    await w.answer("GET never-break/telegram", card);
    await w.answer("POST never-break/telegram", { note: "Telegram is off", receipt: "r1" });
    await w.asked("channels");
    change(w.ca);
    await w.answer("channels", telegram);
    await w.answer("channel-setup", { channels: [] });
    await off;
    assert.deepEqual(w.ca.toasts, []);
  });
}

for (const [what, change] of LATE.slice(0, 2)) {
  test(`${what} while the page was read: it is not redrawn and a failed read shows no error`, async (t) => {
    const w = await appsPage(t);
    w.page.revokedPrompts();
    change(w.ca);
    await w.fail("channels", new Error("The engine is not answering"));
    await w.answer("channel-setup", { channels: [] });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(w.ca.renders, 0);
    assert.deepEqual(w.ca.toasts, []);
  });
}

test("a failed first channel read does not claim that no chat app is connected", async (t) => {
  const w = await appsPage(t);
  await w.fail("channels", new Error("Could not read chat apps"));
  await w.answer("channel-setup", { channels: [] });
  await w.drain();
  assert.doesNotMatch(w.page.draw(), /window\.p17d\.no-chat-app/);
  assert.deepEqual(w.ca.toasts, ["Could not read chat apps"]);
});

test("a failed refresh preserves the last verified connection instead of claiming none", async (t) => {
  const w = await appsPage(t);
  await loaded(w);
  const reading = w.page.load();
  await w.fail("channels", new Error("Could not refresh chat apps"));
  await w.answer("channel-setup", { channels: [] });
  await reading;
  assert.match(w.page.draw(), /telegram/);
  assert.doesNotMatch(w.page.draw(), /window\.p17d\.no-chat-app/);
  assert.deepEqual(w.ca.toasts, ["Could not refresh chat apps"]);
});

test("a successful empty channel read still reports that no app is connected", async (t) => {
  const w = await appsPage(t);
  await w.answer("channels", { channels: [] });
  await w.answer("channel-setup", { channels: [] });
  await w.drain();
  assert.match(w.page.draw(), /window\.p17d\.no-chat-app/);
});

test("an older empty read cannot overwrite the new connection returned by a re-entry refresh", async (t) => {
  const w = await appsPage(t);
  const oldChannels = w.held.splice(w.held.findIndex((h) => h.path === "channels"), 1)[0];
  const oldSetup = w.held.splice(w.held.findIndex((h) => h.path === "channel-setup"), 1)[0];
  const refresh = w.page.load();
  await w.answer("channels", telegram);
  await w.answer("channel-setup", { channels: [] });
  await refresh;
  oldChannels.resolve({ channels: [] });
  oldSetup.resolve({ channels: [] });
  await w.drain();
  assert.match(w.page.draw(), /telegram/);
  assert.doesNotMatch(w.page.draw(), /window\.p17d\.no-chat-app/);
  assert.equal(w.ca.renders, 1, "the superseded read does not redraw");
});

test("a superseded failed read cannot report an error after a successful refresh", async (t) => {
  const w = await appsPage(t);
  const oldChannels = w.held.splice(w.held.findIndex((h) => h.path === "channels"), 1)[0];
  const oldSetup = w.held.splice(w.held.findIndex((h) => h.path === "channel-setup"), 1)[0];
  const refresh = w.page.load();
  await w.answer("channels", telegram);
  await w.answer("channel-setup", { channels: [] });
  await refresh;
  oldChannels.reject(new Error("An old request failed"));
  oldSetup.resolve({ channels: [] });
  await w.drain();
  assert.match(w.page.draw(), /telegram/);
  assert.deepEqual(w.ca.toasts, []);
  assert.equal(w.ca.renders, 1);
});
