/* The final Trunk-choice refresh publishes through the real state/session modules. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const read = name => readFile(new URL(`../public/app/${name}`, import.meta.url), "utf8");
function actual(source, select = () => true) {
  const parsed = ts.createSourceFile("fixture.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return parsed.statements.filter(node => !ts.isImportDeclaration(node) && select(node)).map(node => {
    let text = node.getText(parsed);
    for (const modifier of [...(node.modifiers ?? [])].reverse()) if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      const start = modifier.getStart(parsed) - node.getStart(parsed);
      text = text.slice(0, start) + text.slice(modifier.end - node.getStart(parsed));
    }
    return text;
  }).join("\n");
}
const state = actual(await read("core/state.js")), pages = actual(await read("core/session-pages.js"));
const plus = actual(await read("chat/plus.js"), node => ts.isFunctionDeclaration(node) && node.name?.text === "chooseWho"
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText() === "Q"))
  .replace('import("./chat.js")', "importChat()");
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const profiles = { active: null, isOwner: true, owner: { name: "Owner" } };
const trunkReply = { trunks: [{ id: "scout", name: "New Scout" }], modes: { trunks: "on", conversations: "on" }, defaultId: "home",
  rooms: [{ id: "private-room" }], characters: [{ id: "private-character" }] };
const sessionReply = { sessions: [{ sessionId: "private-session" }], archived: 2, deleted: 3, profileId: null, isOwner: true };
function fixture() {
  const requests = [], waiters = [], observers = [], toasts = [], opened = [];
  let rendered = 0;
  const box = { value: "Kept draft" }, app = { locked: false, classList: { contains: () => app.locked } };
  const context = { AbortController, addEventListener() {}, t: key => key, render: () => { rendered++; }, closePop() {},
    toast: message => toasts.push(message), $: selector => selector === "#app" ? app : box,
    document: { getElementById: id => id === "app" ? app : null },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
      observe() {} takeRecords() { return this.records.splice(0); } disconnect() { this.disconnected = true; }
    },
    newConversationProject: () => "default", newConversationBinding: () => "original-composer",
    api: (path, body) => {
      if (path === "trunks/conversations") return Promise.resolve({ sessionId: "created" });
      const gate = deferred(); requests.push({ path, body, ...gate });
      for (const waiter of waiters.splice(0)) waiter(); return gate.promise;
    },
  };
  context.importChat = async () => ({ openConversation: async id => { opened.push(id); context.windowState.S.chat = id; return true; } });
  runInNewContext(pages + "\n" + state + "\n" + plus
    + "\nglobalThis.windowState = { S, E, Q, refresh, resetSessionPages, sessionAuthority, chooseWho, sessionPages };", context);
  const f = context.windowState;
  Object.assign(f.E, { profiles, state: { marker: "old-state" }, trunks: [{ id: "scout", name: "Old Scout" }],
    trunkModes: { trunks: "on", conversations: "on" }, defaultTrunkId: "home", rooms: [{ id: "old-room" }],
    characters: [{ id: "old-character" }], sessions: [{ sessionId: "old-session" }], putAway: { archived: 0, deleted: 0 } });
  f.resetSessionPages(f.E.profiles);
  const waitRequests = async count => { while (requests.length < count) await new Promise(resolve => waiters.push(resolve)); };
  return { ...f, app, context, requests, waitRequests, toasts, opened, observers,
    rendered: () => rendered,
    choose: () => f.chooseWho({ dataset: { v: "scout" } }),
    profileRoundtrip: () => {
      const original = f.E.profiles;
      f.E.profiles = { active: { id: "sam" }, isOwner: false }; f.resetSessionPages(f.E.profiles);
      f.E.profiles = original; f.resetSessionPages(original);
    },
    lockRoundtrip: () => { app.locked = false; for (const observer of observers) observer.records.push({ oldValue: "locked-b17" }); },
  };
}
async function reach(f, phase) {
  await f.waitRequests(1);
  if (phase === "state") return;
  f.requests[0].resolve({ marker: "new-state" }); await f.waitRequests(3);
  if (phase === "metadata") return;
  f.requests[1].resolve(trunkReply); f.requests[2].resolve(profiles); await f.waitRequests(4);
}
function release(f, phase) {
  if (phase === "state") f.requests[0].resolve({ marker: "new-state" });
  else if (phase === "metadata") { f.requests[1].resolve(trunkReply); f.requests[2].resolve(profiles); }
  else f.requests[3].resolve(sessionReply);
}
for (const phase of ["state", "metadata", "sessions"]) for (const transition of ["profileRoundtrip", "lockRoundtrip"]) {
  test(`final Trunk refresh drops ${phase} publications after ${transition} without a newer refresh`, async () => {
    const f = fixture(), pending = f.choose(); await reach(f, phase);
    f[transition]();
    const before = JSON.stringify(f.E), count = f.requests.length;
    release(f, phase); await pending;
    assert.equal(JSON.stringify(f.E), before, "all actual private cache publications stay dropped");
    assert.equal(f.rendered(), 0); assert.equal(f.requests.length, count, "no next refresh request begins");
    assert.deepEqual(f.toasts, []); assert.deepEqual(f.opened, ["created"]);
    assert.equal(f.Q.choosing, false); assert.ok(f.observers.every(observer => observer.disconnected));
  });
}
test("final Trunk refresh rejects a returned different principal before publishing profiles, state or Trunks", async () => {
  const f = fixture(), pending = f.choose(); await reach(f, "metadata");
  const before = JSON.stringify(f.E);
  f.requests[1].resolve(trunkReply); f.requests[2].resolve({ active: { id: "sam" }, isOwner: false }); await pending;
  assert.equal(JSON.stringify(f.E), before); assert.equal(f.rendered(), 0); assert.equal(f.requests.length, 3);
});
test("an unchanged final Trunk refresh publishes the real caches and renders once", async () => {
  const f = fixture(), pending = f.choose(); await reach(f, "sessions"); release(f, "sessions"); await pending;
  assert.equal(f.E.state.marker, "new-state"); assert.equal(f.E.profiles.isOwner, true);
  assert.equal(f.E.trunks[0].name, "New Scout"); assert.equal(f.E.rooms[0].id, "private-room");
  assert.equal(f.E.characters[0].id, "private-character"); assert.equal(f.E.sessions[0].sessionId, "private-session");
  assert.equal(f.E.putAway.archived, 2); assert.equal(f.E.putAway.deleted, 3);
  assert.equal(f.E.loaded, true); assert.equal(f.rendered(), 1); assert.deepEqual(f.toasts, []);
});
test("default global refresh callers continue to publish a newly active profile and its caches", async () => {
  const f = fixture(), pending = f.refresh(); await reach(f, "metadata");
  f.requests[1].resolve(trunkReply); f.requests[2].resolve({ active: { id: "sam" }, isOwner: false });
  await f.waitRequests(4); f.requests[3].resolve({ ...sessionReply, profileId: "sam", isOwner: false }); await pending;
  assert.equal(f.E.profiles.active.id, "sam"); assert.equal(f.E.state.marker, "new-state");
  assert.equal(f.E.sessions[0].sessionId, "private-session"); assert.equal(f.E.loaded, true); assert.equal(f.rendered(), 1);
});
test("a current final refresh error still reports feedback and releases its authority observer", async () => {
  const f = fixture(), pending = f.choose(); await f.waitRequests(1);
  f.requests[0].reject(new Error("Current refresh failure")); await pending;
  assert.deepEqual(f.toasts, ["Current refresh failure"]); assert.equal(f.Q.choosing, false);
  assert.ok(f.observers.every(observer => observer.disconnected)); assert.equal(f.rendered(), 0);
});
for (const transition of ["profileRoundtrip", "lockRoundtrip"]) test(`a stale final refresh error after ${transition} stays quiet`, async () => {
  const f = fixture(), pending = f.choose(); await f.waitRequests(1); f[transition]();
  const before = JSON.stringify(f.E); f.requests[0].reject(new Error("Stale refresh failure")); await pending;
  assert.deepEqual(f.toasts, []); assert.equal(JSON.stringify(f.E), before); assert.equal(f.rendered(), 0);
  assert.equal(f.Q.choosing, false); assert.ok(f.observers.every(observer => observer.disconnected));
});
