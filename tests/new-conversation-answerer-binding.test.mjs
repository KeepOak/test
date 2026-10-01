import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/app/chat/plus.js", import.meta.url), "utf8");
const chat = await readFile(new URL("../public/app/chat/chat.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("async function chooseWho(el)"), source.indexOf("/* The files waiting"))
  .replace('import("./chat.js")', "importChat()");
const principals = await readFile(new URL("../public/app/core/session-pages.js", import.meta.url), "utf8");
const principalSource = principals.match(/export const sessionPrincipal = (.*);/)[1];
const sessionPrincipal = runInNewContext(`(${principalSource})`);
const authoritySource = principals.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const bindingSource = chat.match(/export const newConversationBinding = (.*);/)[1];
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const imported = deferred(), requested = deferred(), entered = deferred();
  const box = { value: "Kept draft" }, posts = [], opened = [], toasts = [];
  const S = { chat: null, view: "chat", signedIn: true, drafts: { new: "Kept draft" } };
  const E = { profiles: { active: null, isOwner: true }, defaultTrunkId: "home", trunkModes: { trunks: "on", conversations: "on" }, trunks: [{ id: "scout", hidden: false }] };
  const C = { seat: 1, project: "default" }, Q = { choosing: false, temporary: false };
  const selection = { id: "home" }, el = { dataset: { v: "scout" } }, app = { locked: false, classList: { contains: () => app.locked } };
  const lockRecords = [];
  const context = { addEventListener() {}, MutationObserver: class { constructor(hear) { this.hear = hear; } observe() {} takeRecords() { return lockRecords.splice(0); } disconnect() {} },
    S, E, C, Q, lineTrunk: () => selection, closePop() {}, $: selector => selector === "#app" ? app : box,
    sessionPrincipal,
    importChat: () => imported.promise, api: async (path, body) => { posts.push({ path, body }); entered.resolve(); return requested.promise; },
    refresh: async () => {}, toast: error => { toasts.push(error); } };
  runInNewContext(authoritySource + "\nglobalThis.sessionAuthority = sessionAuthority; globalThis.resetSessionPages = resetSessionPages;", context);
  context.resetSessionPages(E.profiles);
  context.newConversationProject = () => C.project ?? "default";
  context.newConversationBinding = runInNewContext(`(${bindingSource})`, context);
  const choose = runInNewContext(`(${handler})`, context);
  const releaseImport = () => imported.resolve({ openConversation: async id => { opened.push(id); } });
  return { lockRecords, context, S, E, C, Q, selection, el, app, posts, opened, toasts, imported, requested, entered, releaseImport, choose: () => choose(el) };
}
const changes = {
  profile: f => { f.E.profiles = { active: { id: "sam" }, isOwner: false }; },
  lock: f => { f.app.locked = true; },
  profileRoundtrip: f => { const original = f.E.profiles; f.E.profiles = { active: { id: "sam" }, isOwner: false }; f.context.resetSessionPages(f.E.profiles); f.E.profiles = original; f.context.resetSessionPages(original); },
  lockRoundtrip: f => { f.lockRecords.push({ oldValue: "locked-b17" }); f.app.locked = false; },
  project: f => { f.C.project = "another-project"; },
  selection: f => { f.selection.id = "another-trunk"; },
  composer: f => { f.C.seat += 1; },
  hidden: f => { f.E.trunks[0].hidden = true; },
  default: f => { f.E.defaultTrunkId = "scout"; },
  temporary: f => { f.Q.temporary = true; },
  off: f => { f.E.trunkModes.conversations = "off"; },
  signedOut: f => { f.S.signedIn = false; },
};
for (const [name, change] of Object.entries(changes)) {
  test(`UI-032: ${name} change during import prevents creation`, async () => {
    const f = fixture(), pending = f.choose();
    change(f); f.releaseImport(); await pending;
    assert.deepEqual(f.posts, []); assert.deepEqual(f.opened, []);
    assert.equal(f.S.drafts.new, "Kept draft"); assert.equal(f.Q.choosing, false);
  });
  test(`UI-032: ${name} change during create preserves the current draft and conversation`, async () => {
    const f = fixture(), pending = f.choose();
    f.releaseImport(); await f.entered.promise;
    change(f); f.requested.resolve({ sessionId: "created" }); await pending;
    assert.equal(f.posts.length, 1); assert.deepEqual(f.opened, []);
    assert.equal(f.S.drafts.new, "Kept draft"); assert.equal(f.S.drafts.created, undefined);
    assert.equal(f.Q.choosing, false);
  });
}
test("UI-032: an unchanged choice creates once and moves the draft", async () => {
  const f = fixture(), pending = f.choose();
  await f.choose(); assert.equal(f.posts.length, 0, "a concurrent choice waits");
  f.releaseImport(); await f.entered.promise;
  f.requested.resolve({ sessionId: "created" }); await pending;
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].body.trunkId, "scout"); assert.equal(f.posts[0].body.project, "default");
  assert.deepEqual(f.opened, ["created"]); assert.equal(f.S.drafts.created, "Kept draft");
  assert.equal(f.S.drafts.new, undefined); assert.equal(f.Q.choosing, false);
});

for (const phase of ["import", "create"]) {
  for (const name of ["current", "profile", "lock", "project"]) {
    test(`UI-032: ${phase} failure ${name === "current" ? "reports the current error" : `after ${name} change is quiet`}`, async () => {
      const f = fixture(), pending = f.choose();
      if (phase === "create") { f.releaseImport(); await f.entered.promise; }
      if (name !== "current") changes[name](f);
      f[phase === "import" ? "imported" : "requested"].reject(new Error("Choice failed"));
      await pending;
      assert.deepEqual(f.toasts, name === "current" ? ["Choice failed"] : []);
      assert.equal(f.posts.length, phase === "create" ? 1 : 0);
      assert.deepEqual(f.opened, []);
      assert.equal(f.S.drafts.new, "Kept draft");
      assert.equal(f.S.drafts.created, undefined);
      assert.equal(f.Q.choosing, false);
    });
  }
}
