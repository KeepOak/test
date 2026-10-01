/* Actual Accounts handlers and canonical fences, with deferred local stand-ins only. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const read = name => readFile(new URL(`../public/app/${name}`, import.meta.url), "utf8");
function declarations(source, pick = () => true) {
  const parsed = ts.createSourceFile("fixture.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return parsed.statements.filter(node => !ts.isImportDeclaration(node) && pick(node)).map(node => {
    let text = node.getText(parsed);
    for (const modifier of [...(node.modifiers ?? [])].reverse()) if (modifier.kind === ts.SyntaxKind.ExportKeyword) {
      const start = modifier.getStart(parsed) - node.getStart(parsed);
      text = text.slice(0, start) + text.slice(modifier.end - node.getStart(parsed));
    }
    return text;
  }).join("\n");
}
const source = declarations(await read("settings/more18.js"));
const fence = declarations(await read("core/view-fence.js"));
const principal = declarations(await read("core/session-pages.js"), node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText() === "sessionPrincipal"));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const requests = [], waiters = [], toasts = [], opened = [], actions = {}, drawHooks = [];
  const nodes = Object.fromEntries(["client", "secret"].map(kind => {
    const id = `more18-google-${kind}`;
    return [id, { id, value: kind === "client" ? "client-id" : "fixture-secret", isConnected: true }];
  }));
  const app = { locked: false, classList: { contains: () => app.locked } }, observers = [];
  const S = { signedIn: true, project: "default", view: "settings", setPage: "accounts" };
  const E = { profiles: { active: null, isOwner: true }, state: { lock: { locked: false } } };
  let renders = 0, revision = 0;
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe() {}
    takeRecords() { return this.records.splice(0); }
  }
  const context = { S, E, URL, MutationObserver, document: { getElementById: id => id === "app" ? app : nodes[id], addEventListener() {} },
    ownerHere: () => E.profiles.isOwner === true, dialogRevision: () => revision,
    renderNow: () => { renders++; }, afterDraw: callback => drawHooks.push(callback), on: (name, handler) => { actions[name] = handler; },
    esc: value => String(value ?? ""), ic: () => "", t: key => key, markLive() {}, toast: message => toasts.push(message),
    api: (path, body) => { const gate = deferred(); requests.push({ path, body, ...gate });
      for (const waiter of waiters.splice(0)) waiter(); return gate.promise; },
    window: { open: address => { opened.push(address); } } };
  runInNewContext(principal + "\n" + fence + "\n" + source
    + "\nglobalThis.fixtureAccounts = { M, loadMore, testConnector, testConnection, save, signIn, moreSections, initMore };", context);
  const handlers = context.fixtureAccounts;
  handlers.initMore(); handlers.moreSections();
  const seed = () => {
    handlers.M.signin.google = { settings: { clientId: "original" }, status: { signedIn: true, health: null } };
    handlers.M.home = { settings: { url: "https://home.example" } };
  };
  seed();
  const waitRequests = async count => { while (requests.length < count) await new Promise(resolve => waiters.push(resolve)); };
  const flushMutation = () => { for (const observer of observers) { const records = observer.takeRecords(); if (records.length) observer.callback(records); } };
  return { S, E, app, nodes, handlers, actions, requests, toasts, opened, seed, waitRequests,
    renders: () => renders, dialog: () => { revision++; },
    transientLock: (flush = true) => { app.locked = true; app.locked = false;
      for (const observer of observers) observer.records.push({ oldValue: "" }, { oldValue: "locked-b17" });
      if (flush) flushMutation(); }, flushMutation };
}
const transitions = {
  profile: f => { f.E.profiles = { active: { id: "sam" }, isOwner: false }; },
  lock: f => { f.app.locked = true; }, project: f => { f.S.project = "other-project"; },
  navigation: f => { f.S.view = "chat"; }, setPage: f => { f.S.setPage = "general"; },
  dialog: f => f.dialog(), transientLock: f => f.transientLock(),
  newerLoad: f => { f.handlers.loadMore(); },
  settingsReplacement: f => { f.handlers.M.signin.google = { settings: { clientId: "replacement" }, status: { signedIn: true, marker: "replacement" } };
    f.handlers.M.home = { settings: { url: "https://replacement.example" } }; },
};
const invoke = (f, operation) => operation === "load" ? f.handlers.loadMore()
  : operation === "connector" ? f.handlers.testConnector("home")
  : operation === "connection" ? f.handlers.testConnection("google")
  : f.handlers[operation]("google");
const answer = { health: { ok: true, checks: [] }, status: { signedIn: true, marker: "old-result" }, settings: {}, url: "https://accounts.google.com/fixture" };
function release(request, failure) { failure ? request.reject(new Error("Fixture failure")) : request.resolve(answer); }
for (const operation of ["load", "connector", "connection", "save", "signIn"]) {
  for (const failure of [false, true]) for (const [name, transition] of Object.entries(transitions)) {
    // Replacing a service setting does not invalidate a load of that same setting; a newer load does.
    if (operation === "load" && name === "settingsReplacement") continue;
    test(`Accounts ${operation} ${failure ? "error" : "success"} is fenced after ${name}`, async () => {
      const f = fixture(), pending = invoke(f, operation);
      await f.waitRequests(operation === "load" ? 3 : 1);
      const oldRequests = f.requests.slice();
      transition(f); f.handlers.moreSections();
      f.handlers.M.checking.home = "newer-work"; f.handlers.M.checking.google = "newer-work";
      const before = JSON.stringify(f.handlers.M), rendered = f.renders(), requestCount = f.requests.length;
      for (const request of oldRequests) release(request, failure);
      await pending;
      assert.equal(f.requests.length, requestCount, "stale work starts no further request");
      assert.equal(JSON.stringify(f.handlers.M), before, "stale cache or finally cannot replace newer state");
      assert.equal(f.renders(), rendered, "stale finally cannot redraw");
      assert.deepEqual(f.toasts, [], "stale errors remain quiet");
      assert.deepEqual(f.opened, [], "stale sign-in never opens an address");
      assert.equal(f.nodes["more18-google-secret"].value, "fixture-secret");
    });
  }
}
for (const operation of ["connector", "connection"]) for (const failure of [false, true]) {
  test(`Accounts current ${operation} ${failure ? "error" : "success"} keeps legitimate feedback and finally`, async () => {
    const f = fixture(), pending = invoke(f, operation); await f.waitRequests(1);
    release(f.requests[0], failure); await pending;
    assert.equal(f.handlers.M.checking[operation === "connector" ? "home" : "google"], false);
    assert.equal(f.renders(), 2); assert.deepEqual(f.toasts, failure ? ["Fixture failure"] : []);
    if (!failure) assert.equal(operation === "connector" ? f.handlers.M.connectorHealth.home.ok : f.handlers.M.signin.google.status.marker, operation === "connector" ? true : "old-result");
  });
}
test("a successful own token refresh publishes the changed expiry and clears its checking state once", async () => {
  const f = fixture();
  f.handlers.M.signin.google.status.expiresAt = "2026-09-30T10:00:00.000Z";
  f.handlers.M.signin.google.status.scope = "read-only";
  const pending = f.handlers.testConnection("google"); await f.waitRequests(1);
  assert.equal(f.handlers.M.checking.google, true);
  f.requests[0].resolve({ status: { signedIn: true, expiresAt: "2026-10-01T10:00:00.000Z", scope: "read-only", health: { ok: true } } });
  await pending;
  assert.equal(f.handlers.M.signin.google.status.expiresAt, "2026-10-01T10:00:00.000Z");
  assert.equal(f.handlers.M.checking.google, false);
  assert.equal(f.renders(), 2, "one admission draw and one accepted-result draw");
  assert.deepEqual(f.toasts, []);
});
for (const failure of [false, true]) test(`Accounts current load ${failure ? "service errors" : "success"} finishes its bounded reads`, async () => {
  const f = fixture(), pending = f.handlers.loadMore(); await f.waitRequests(3);
  for (const request of f.requests.slice()) release(request, failure);
  for (let count = 4; count <= 7; count++) { await f.waitRequests(count); f.requests[count - 1].resolve(answer); }
  await pending;
  assert.deepEqual(f.requests.map(request => request.path), ["personal/signin/google", "personal/signin/microsoft", "personal/signin/spotify", "personal/home", "personal/mail", "connectors/accounts", "mcp/servers"]);
  assert.equal(f.renders(), 1); assert.equal(f.toasts.length, failure ? 3 : 0);
});
for (const failure of [false, true]) test(`Accounts current save ${failure ? "error" : "success"} keeps valid behavior`, async () => {
  const f = fixture(), pending = f.handlers.save("google"); await f.waitRequests(1);
  release(f.requests[0], failure);
  if (!failure) { await f.waitRequests(2); f.requests[1].resolve(answer); }
  assert.equal(await pending, !failure);
  assert.deepEqual(f.toasts, failure ? ["Fixture failure"] : []);
  assert.equal(f.nodes["more18-google-secret"].value, failure ? "fixture-secret" : "");
});
for (const failure of [false, true]) test(`Accounts current sign-in ${failure ? "start error" : "success"} keeps valid behavior`, async () => {
  const f = fixture(), pending = f.handlers.signIn("google");
  await f.waitRequests(1); f.requests[0].resolve(answer);
  await f.waitRequests(2); f.requests[1].resolve(answer);
  await f.waitRequests(3); release(f.requests[2], failure); await pending;
  assert.deepEqual(f.opened, failure ? [] : [answer.url]);
  assert.deepEqual(f.toasts, failure ? ["Fixture failure"] : ["personal.signin.opened"]);
});
for (const operation of ["save", "signIn"]) for (const failure of [false, true]) for (const [name, transition] of Object.entries(transitions)) {
  test(`Accounts ${operation} late ${failure ? "error" : "success"} is fenced after ${name}`, async () => {
    const f = fixture(), pending = f.handlers[operation]("google");
    await f.waitRequests(1); f.requests[0].resolve(answer);
    await f.waitRequests(2);
    if (operation === "signIn") { f.requests[1].resolve(answer); await f.waitRequests(3); }
    const request = f.requests.at(-1);
    transition(f); f.handlers.moreSections();
    const before = JSON.stringify(f.handlers.M), rendered = f.renders(), count = f.requests.length;
    release(request, failure); await pending;
    assert.equal(f.requests.length, count, "late stale completion starts no network step");
    assert.equal(JSON.stringify(f.handlers.M), before);
    assert.equal(f.renders(), rendered); assert.deepEqual(f.toasts, []); assert.deepEqual(f.opened, []);
    if (operation === "save") assert.equal(f.nodes["more18-google-secret"].value, "fixture-secret");
  });
}
for (const operation of ["save", "signIn"]) for (const failure of [false, true]) {
  test(`Accounts ${operation} replaced input ${failure ? "error" : "success"} cannot act on the new card`, async () => {
    const f = fixture(), pending = f.handlers[operation]("google"); await f.waitRequests(1);
    for (const kind of ["client", "secret"]) {
      const id = `more18-google-${kind}`; f.nodes[id] = { id, value: "replacement-input", isConnected: true };
    }
    release(f.requests[0], failure); await pending;
    assert.equal(f.requests.length, 1); assert.deepEqual(f.toasts, []); assert.deepEqual(f.opened, []);
    assert.equal(f.nodes["more18-google-secret"].value, "replacement-input");
  });
}
for (const operation of ["connector", "connection"]) for (const failure of [false, true]) {
  test(`Accounts ${operation} drains a pending transient-lock mutation before ${failure ? "error" : "success"}`, async () => {
    const f = fixture(), pending = invoke(f, operation); await f.waitRequests(1);
    f.transientLock(false); release(f.requests[0], failure); await pending;
    assert.deepEqual(Object.keys(f.handlers.M.connectorHealth), []);
    assert.deepEqual(Object.keys(f.handlers.M.signin), []);
    assert.equal(f.renders(), 1, "stale finally does not redraw after taking mutation records");
    assert.deepEqual(f.toasts, []); assert.equal(f.requests.length, 1);
  });
}
