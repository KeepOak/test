/* Settings › Chat apps with its real child readers (formatting, reply style, phone access): the page's read goes on to
   each child's own request, and if the App lock comes on or another person's profile is switched to while those child
   requests wait, their late answers and errors change nothing: no toast, no redraw, and each child's cache as it was.
   The real chatapps.js and its three real child modules run in Node; only the window's core modules and unrelated page
   parts are stand-ins. Every request is held open by the test, so the change happens between the two stages.
   Mutation: drop still() in any child reader (chat-formatting.js, chat-reply-style.js, phone-access.js) -> this fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const REAL = ["settings/pages/chatapps.js", "settings/chat-formatting.js", "settings/chat-reply-style.js", "settings/phone-access.js"];
const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const render = () => { globalThis.__cc.renders++; };",
  "app/core/state.js": `export const level = () => 1; export const S = globalThis.__cc.S; export const E = globalThis.__cc.E;
    export const ownerHere = () => globalThis.__cc.owner; export const activeId = () => globalThis.__cc.profile;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__cc.api(path, body);",
  "app/core/ui.js": "export const toast = (m) => globalThis.__cc.toasts.push(m); export const openDlg = () => {}; export const closeDlg = () => {}; export const dialog = () => null;",
  "app/core/logos.js": "export const logo = () => \"\";",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__cc.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/settings/owner-commands.js": "export const initOwnerCommands = () => {}; export const ownerCommandCard = () => \"\";",
  "app/settings/chat-steps.js": "export const stepsCard = () => \"\"; export const initSteps = () => {};",
  "app/settings/chat-routing.js": "export const routingCard = () => \"\"; export const initRouting = () => {};",
  "app/settings/rows15.js": "export const sw15 = () => \"\"; export const sec15 = () => \"\"; export const seg15 = () => \"\"; export const id15 = (s) => s;",
  "app/flows/chatapps17d.js": "export const nativeFormat = () => \"\"; export const pill17d = () => \"\"; export const stateOf = () => [];",
  "i18n.js": "export const t = (key) => key;",
};

async function page(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chatapps-children-"));
  for (const dir of ["app/settings/pages", "app/core", "app/flows"]) await mkdir(join(root, dir), { recursive: true });
  for (const file of REAL) await writeFile(join(root, "app", file), await readFile(new URL(`../public/app/${file}`, import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const cc = { S: { view: "settings" }, E: { profiles: { isOwner: true } }, owner: true, profile: null, locked: false, toasts: [], acts: {}, renders: 0,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })) };
  globalThis.__cc = cc;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && cc.locked } } : null),
    addEventListener: () => {} };
  t.after(async () => { delete globalThis.__cc; delete globalThis.document; await discardTemp(root); });
  const load = (file) => import(pathToFileURL(join(root, "app", file)).href);
  const [apps, formatting, replies, phone] = await Promise.all(REAL.map(load));
  const asked = async (path) => { for (let i = 0; i < 100 && !held.some((h) => h.path === path); i++) await Promise.resolve(); };
  const take = async (path) => { await asked(path); const at = held.findIndex((h) => h.path === path); assert.ok(at >= 0, `asked for ${path}`); return held.splice(at, 1)[0]; };
  return { cc, apps, formatting, replies, phone, take };
}
const plain = (m) => /data-v="plain" aria-pressed="true"/.test(m.formatButtons("telegram", "Native"));
const first = (m) => /data-act="chquote"[^>]*data-v="first" aria-pressed="true"/.test(m.replyStyleRows("telegram", "Telegram"));

for (const [what, change] of [["the App lock came on", (cc) => { cc.locked = true; }], ["another person's profile was switched to", (cc) => { cc.profile = "p-2"; }]]) {
  test(`${what} between the page's read and its child readers' requests: nothing is kept, drawn or said`, async (t) => {
    const { cc, apps, formatting, replies, phone, take } = await page(t);
    apps.revokedPrompts();
    (await take("channels")).resolve({ channels: [] });
    (await take("channel-setup")).resolve({ channels: [] });
    (await take("channels/routes")).resolve(null); // #588: the routing card reads its routes with the page
    const [formats, styles, access] = [await take("channels/formatting"), await take("channels/reply-style"), await take("miniapp/phone-access")];
    change(cc);
    formats.reject(new Error("formatting is not answering"));
    styles.resolve({ styles: { telegram: { quote: "first" } } });
    access.resolve({ phoneAccess: { url: "https://phone.example", pinSet: true, on: ["x"] } });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.deepEqual(cc.toasts, [], "no late error from a child reader");
    assert.equal(cc.renders, 0, "the page was not redrawn");
    assert.equal(first(replies), false, "reply styles kept as they were");
    assert.equal(phone.phoneAccessCard(), "", "phone access kept as it was");
    assert.equal(plain(formatting), false);
  });
}

test("with nothing changed, the page and its child readers keep their answers and draw once", async (t) => {
  const { cc, apps, formatting, replies, phone, take } = await page(t);
  apps.revokedPrompts();
  (await take("channels")).resolve({ channels: [] });
  (await take("channel-setup")).resolve({ channels: [] });
  (await take("channels/routes")).resolve(null); // #588: the routing card reads its routes with the page
  (await take("channels/formatting")).resolve({ formats: { telegram: "plain" } });
  (await take("channels/reply-style")).resolve({ styles: { telegram: { quote: "first" } } });
  (await take("miniapp/phone-access")).resolve({ phoneAccess: { url: "https://phone.example", pinSet: true, on: ["x"] } });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert.equal(cc.renders, 1);
  assert.equal(plain(formatting), true);
  assert.equal(first(replies), true);
  assert.notEqual(phone.phoneAccessCard(), "");
});
