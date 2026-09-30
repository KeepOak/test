/* Settings › Chat apps reads three parts of its page from their own modules: each app's formatting, its reply style,
   and phone access. Each reader (and each part's own save) keeps its answer, draws, or shows its error only for the
   newest read by the same owner on the same page with the window unlocked. A late answer after the App lock, a person
   switch or a page change leaves the part's cache as it was and says nothing.
   The real modules run in Node next to stand-ins for the window's core modules; each read is held open by the test.
   Mutation: drop still() before a cache write or toast in any of the three modules -> its cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const esc = (s) => String(s ?? \"\"); export const render = () => { globalThis.__rd.renders++; };",
  "app/core/api.js": "export const api = (path, body) => globalThis.__rd.api(path, body);",
  "app/core/ui.js": "export const toast = (m) => globalThis.__rd.toasts.push(m); export const openDlg = () => {}; export const closeDlg = () => { globalThis.__rd.closed++; };",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__rd.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/state.js": "export const S = globalThis.__rd.S; export const ownerHere = () => globalThis.__rd.owner; export const activeId = () => globalThis.__rd.profile;",
  "i18n.js": "export const t = (key) => key;",
};

async function reader(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-reader-${name}-`));
  for (const dir of ["app/settings", "app/core"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "settings", `${name}.js`), await readFile(new URL(`../public/app/settings/${name}.js`, import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const rd = { S: { view: "settings" }, owner: true, profile: null, locked: false, toasts: [], acts: {}, renders: 0, closed: 0,
    api: (path, body) => new Promise((resolve, reject) => held.push({ path, body, resolve, reject })) };
  globalThis.__rd = rd;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && rd.locked } } : null) };
  t.after(async () => { delete globalThis.__rd; delete globalThis.document; await discardTemp(root); });
  const mod = await import(pathToFileURL(join(root, "app", "settings", `${name}.js`)).href);
  const next = async () => { for (let i = 0; i < 50 && !held.length; i++) await Promise.resolve(); assert.ok(held.length, "a read was asked for"); return held.shift(); };
  return { mod, rd, next };
}

const CHANGES = [
  ["the App lock came on", (rd) => { rd.locked = true; }],
  ["another person's profile was switched to", (rd) => { rd.profile = "p-2"; }],
  ["the owner moved to another page", (rd) => { rd.S.view = "chat"; }],
];
const plainPressed = (html) => /data-v="plain" aria-pressed="true"/.test(html);
const quoteFirst = (html) => /data-act="chquote"[^>]*data-v="first" aria-pressed="true"/.test(html);
const phoneOn = (html) => html.includes(`data-phone-access="on"`);
const phone = { url: "https://phone.example/app", pinSet: true, on: ["tailscale", "serve"], off: ["tailscale", "serve", "off"] };

/* Each part: how its read starts, its answer, and how the page shows what it kept. */
const PARTS = [
  { name: "chat-formatting", what: "each app's formatting", start: (m) => m.loadFormats(), answer: { formats: { telegram: "plain" } },
    kept: (m) => plainPressed(m.formatButtons("telegram", "Native")) },
  { name: "chat-reply-style", what: "each app's reply style", start: (m) => m.loadReplyStyles(), answer: { styles: { telegram: { quote: "first" } } },
    kept: (m) => quoteFirst(m.replyStyleRows("telegram", "Telegram")) },
  { name: "phone-access", what: "phone access", start: (m) => m.loadPhoneAccess(), answer: { phoneAccess: phone },
    kept: (m) => phoneOn(m.phoneAccessCard()) },
];

for (const part of PARTS) {
  test(`with nothing changed, ${part.what} is kept once read`, async (t) => {
    const { mod, next } = await reader(t, part.name);
    const reading = part.start(mod);
    (await next()).resolve(part.answer);
    await reading;
    assert.equal(part.kept(mod), true);
  });
  for (const [what, change] of CHANGES) {
    test(`${what} while ${part.what} was read: the late answer is not kept`, async (t) => {
      const { mod, rd, next } = await reader(t, part.name);
      const reading = part.start(mod);
      const read = await next();
      change(rd);
      read.resolve(part.answer);
      await reading;
      assert.equal(part.kept(mod), false);
    });
    test(`${what} while ${part.what} was read: a failed read says nothing`, async (t) => {
      const { mod, rd, next } = await reader(t, part.name);
      const reading = part.start(mod);
      const read = await next();
      change(rd);
      read.reject(new Error("The engine is not answering"));
      await reading;
      assert.deepEqual(rd.toasts, []);
    });
  }
}

/* The parts' own saves follow the same rule. */
const SAVES = [
  { name: "chat-formatting", what: "a formatting choice", init: (m) => m.initFormatting(),
    press: (rd) => rd.acts.chfmt17d({ dataset: { id: "telegram", v: "plain" }, parentElement: { querySelectorAll: () => [] } }),
    answer: { formats: { telegram: "plain" } }, kept: (m) => plainPressed(m.formatButtons("telegram", "Native")) },
  { name: "chat-reply-style", what: "a reply style choice", init: (m) => m.initReplyStyle(),
    press: (rd) => rd.acts.chquote({ dataset: { id: "telegram", v: "first" } }),
    answer: { styles: { telegram: { quote: "first" } } }, kept: (m) => quoteFirst(m.replyStyleRows("telegram", "Telegram")) },
];
for (const save of SAVES) {
  for (const [what, change] of CHANGES.slice(0, 2)) {
    test(`${what} while ${save.what} was saved: nothing is kept, drawn or said`, async (t) => {
      const { mod, rd, next } = await reader(t, save.name);
      save.init(mod);
      const saving = save.press(rd);
      const read = await next();
      change(rd);
      read.resolve(save.answer);
      await saving;
      assert.equal(save.kept(mod), false);
      assert.equal(rd.renders, 0);
    });
  }
}

test("the App lock came on while phone access was being turned on: the dialog is left and nothing is read or said", async (t) => {
  const { mod, rd, next } = await reader(t, "phone-access");
  const loading = mod.loadPhoneAccess();
  (await next()).resolve({ phoneAccess: { ...phone, url: null } });
  await loading;
  let reloads = 0;
  mod.initPhoneAccess(async () => { reloads++; });
  const running = rd.acts["phone-access-run"]({ dataset: { v: "on" }, disabled: false });
  const read = await next();
  rd.locked = true;
  read.reject(new Error("Tailscale is not answering"));
  await running;
  assert.deepEqual(rd.toasts, []);
  assert.equal(reloads, 0);
});
