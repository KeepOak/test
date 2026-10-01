/* CHAT-255: the Telegram card's "Photos and files" switch saves at once; its answer is drawn, or its error shown, only on
   the wizard that asked. If the App lock came on, the owner moved page or switched person, another dialog opened, or a
   newer wizard started while it saved, the late answer changes nothing on screen.
   The real public/app/flows/chat.js runs in Node next to stand-ins for the window's core modules; the save is held open
   by the test, so the change happens while it waits, with no timers.
   Mutation: drop still() from saveMedia (the redraw, the toast or keeping the answer) -> the late cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const $ = () => null; export const esc = (s) => String(s ?? \"\");",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__ms.openDlg(o); export const closeDlg = () => { globalThis.__ms.dlg = null; };
    export const dialog = () => globalThis.__ms.dlg; export const toast = (m) => globalThis.__ms.toasts.push(m); export const ic = () => "";`,
  "app/core/state.js": `export const S = globalThis.__ms.S; export const E = {}; export const refresh = async () => {};
    export const ownerHere = () => globalThis.__ms.owner; export const activeId = () => globalThis.__ms.profile;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__ms.api(path, body);",
  "app/core/actions.js": "export const on = () => {};",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/logos.js": "export const logo = () => \"\";",
  "app/core/qr.js": "export const qr = () => \"\";",
  "app/flows/chatapps17d.js": "export const manage17d = () => \"\"; export const fixNote17d = () => \"\";",
  "i18n.js": "export const t = (key) => key;",
};

async function mediaPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-media-switch-"));
  for (const dir of ["app/flows", "app/core"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "flows", "chat.js"), await readFile(new URL("../public/app/flows/chat.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [], opened = [], inputs = [];
  const ms = { S: { view: "customize" }, owner: true, profile: null, locked: false, toasts: [], dlg: null,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })),
    openDlg: (o) => { opened.push(o); ms.dlg = { wizard: o }; return ms.dlg; } };
  globalThis.__ms = ms;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && ms.locked } } : null),
    addEventListener: (type, fn) => { if (type === "input") inputs.push(fn); } };
  t.after(async () => { delete globalThis.__ms; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "flows", "chat.js")).href);
  page.init();
  const settle = async (path, how, value) => {
    for (let i = 0; i < 50 && !held.some((h) => h.path === path); i++) await Promise.resolve();
    const at = held.findIndex((h) => h.path === path);
    assert.ok(at >= 0, `asked for ${path}`);
    held.splice(at, 1)[0][how](value);
  };
  const answer = (path, value) => settle(path, "resolve", value), fail = (path, error) => settle(path, "reject", error);
  // A connected Telegram opens at Save, where its Photos and files switch is.
  const open = page.openChatWizard("telegram");
  await answer("channel-setup/telegram", { id: "telegram", name: "Telegram" });
  await answer("channels", { channels: [{ id: "telegram", kind: "telegram" }], intake: { telegramMedia: true } });
  await open;
  assert.equal(opened.length, 1, "the wizard opened at Save");
  const flip = () => { for (const fn of inputs) fn({ target: { dataset: { sw: "tg-media" }, checked: false, disabled: false } }); };
  return { page, ms, opened, answer, fail, flip };
}

test("with nothing changed, the saved switch is drawn on its wizard", async (t) => {
  const { ms, opened, answer, flip } = await mediaPage(t);
  flip();
  await answer("channels/intake", { intake: { telegramMedia: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 2, "drawn again with the saved value");
  assert.equal(ms.S.chw.intake.telegramMedia, false);
});

const LATE = [
  ["the App lock came on", (ms) => { ms.locked = true; }],
  ["the owner moved to another page", (ms) => { ms.S.view = "chat"; }],
  ["another person's profile was switched to", (ms) => { ms.profile = "p-2"; }],
  ["another dialog replaced the wizard", (ms) => { ms.dlg = { other: true }; }],
];
for (const [what, change] of LATE) {
  test(`${what} while the switch saved: nothing is drawn`, async (t) => {
    const { ms, opened, answer, flip } = await mediaPage(t);
    flip();
    change(ms);
    const wizard = ms.S.chw;
    await answer("channels/intake", { intake: { telegramMedia: false } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.length, 1);
    assert.equal(wizard.intake.telegramMedia, true, "the late answer is not kept on the wizard either");
  });
  test(`${what} while the switch saved: its error is not shown`, async (t) => {
    const { ms, fail, flip } = await mediaPage(t);
    flip();
    change(ms);
    await fail("channels/intake", new Error("The engine is not answering"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ms.toasts, []);
  });
}
