// UI-271: the context audit reads the request actually sent, and the owner may leave a plain read result out of future
// requests (and put it back); policy or approval evidence, and a stale request, cannot be changed.
import test from "node:test";
import assert from "node:assert/strict";
import { ContextAudit } from "../dist/context-audit.js";
import { contextAuditApi } from "../dist/context-audit-api.js";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

function store(runId, sessionId) {
  const rows = new Map(), events = [];
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }),
    runs: () => [{ id: runId, sessionId }], events: () => [], event: (...e) => events.push(e), logged: events };
}
const run = { id: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", owner: "owner" };
const messages = [
  { role: "system", content: "You are Branch." },
  { role: "user", content: "read the notes" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: "{\"path\":\"notes.md\"}" }, { id: "c2", name: "files.read", arguments: "{\"path\":\"POLICY.md\"}" }] },
  { role: "tool", toolCallId: "c1", content: "a very long notes file ".repeat(50) },
  { role: "tool", toolCallId: "c2", content: "approval rules" },
];

test("a plain read result can be left out of future requests and put back; protected evidence cannot", () => {
  const s = store(run.id, run.sessionId), audit = new ContextAudit();
  const requestId = audit.capture(s, run, messages, [{ name: "files.read", description: "read", parameters: {} }], "m", 100000);
  const view = audit.read(s, "owner", run.sessionId);
  assert.equal(view.available, true);
  assert.deepEqual(view.items.map((i) => [i.callId, i.removable]), [["c1", true], ["c2", false]]);
  assert.throws(() => audit.change(s, "owner", run.sessionId, run.id, requestId, "c2", true), /protected/);
  assert.throws(() => audit.change(s, "owner", run.sessionId, run.id, "33333333-3333-4333-8333-333333333333", "c1", true), /changed/);
  audit.change(s, "owner", run.sessionId, run.id, requestId, "c1", true);
  const sent = audit.prepare(s, run, messages);
  assert.match(sent[3].content, /left out of future model context/);
  assert.equal(sent[4].content, "approval rules");
  assert.equal(messages[3].content.startsWith("a very long"), true, "the conversation itself is untouched");
  audit.change(s, "owner", run.sessionId, run.id, requestId, "c1", false);
  assert.equal(audit.prepare(s, run, messages)[3].content, messages[3].content, "put back");
  assert.equal(audit.read(s, "someone-else", run.sessionId).available, false);
});

// Review 5914164114: a lock and unlock, or a profile switch away and back, while the POST body arrives ends the
// original authority; the later guard alone would pass again and apply a stale exclusion.

function window() {
  const lockListeners = new Set(), switchListeners = new Set(), changes = [];
  let locked = false, scope = "owner";
  return {
    sessionLock: { locked: () => locked, onLocked: (f) => { lockListeners.add(f); return () => lockListeners.delete(f); } },
    store: { ownsSession: () => true, profiles: { isOwner: () => scope === "owner", scope: () => scope,
      onSwitched: (f) => { switchListeners.add(f); return () => switchListeners.delete(f); } } },
    runtime: { contextAudit: { read: () => ({ available: true }), change: (...args) => changes.push(args) } },
    lock() { locked = true; for (const f of lockListeners) f(); }, unlock() { locked = false; },
    switchTo(profile) { scope = profile ?? "owner"; for (const f of switchListeners) f(profile); },
    changes, listening: () => lockListeners.size + switchListeners.size,
  };
}
const path = `/api/sessions/${run.sessionId}/context-audit`;
const body = { runId: run.id, requestId: "33333333-3333-4333-8333-333333333333", callId: "c1", out: true, confirmed: true };

test("a lock or profile switch while the exclusion body arrives revokes the write, even once restored", async () => {
  for (const transition of [(w) => { w.lock(); w.unlock(); }, (w) => { w.switchTo("p1"); w.switchTo(null); }]) {
    const w = window();
    await assert.rejects(contextAuditApi(w, { method: "POST" }, path, async () => { transition(w); return body; }),
      (error) => error.status === 403);
    assert.equal(w.changes.length, 0, "no stale exclusion is applied");
    assert.equal(w.listening(), 0, "the request's subscriptions are released");
  }
  const w = window();
  await contextAuditApi(w, { method: "POST" }, path, async () => body);
  assert.equal(w.changes.length, 1, "an undisturbed write still applies");
  assert.equal(w.listening(), 0);
});

// Review 5925628748 (branch-coord#1): the window's own confirmation must not POST an old proposal after a profile switch
// away and back, or a lock and unlock, while its live read is outstanding, even though nothing re-rendered meanwhile.
const strip = (source) => source.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const [panelSource, pagesSource] = await Promise.all(["shell/context-audit.js", "core/session-pages.js"]
  .map((name) => readFile(new URL(`../public/app/${name}`, import.meta.url), "utf8")));
function windowFixture() {
  const sid = run.sessionId, view = { available: true, runId: run.id, requestId: "33333333-3333-4333-8333-333333333333",
    model: "m", limit: 1000, estimated: 10, reported: null, categories: [], definitions: [], totalDefinitions: 0,
    items: [{ callId: "c1", name: "files.read", tokens: 5, removable: true, excluded: false }], totalItems: 1, compactions: 0, at: new Date().toISOString() };
  const lockRecords = [], posts = [], actions = {}, app = { locked: false, classList: { contains: () => app.locked } };
  let dlg = null, held = null, pop = null, clock = Date.now();
  const pops = [], anchor = {};
  class Clock extends Date { static now() { return clock; } }
  const MutationObserver = class { observe() {} takeRecords() { return lockRecords.splice(0); } disconnect() {} };
  const pages = { MutationObserver, addEventListener() {} };
  runInNewContext(`${strip(pagesSource)}
globalThis.pages = { sessionAuthority, resetSessionPages };`, pages);
  const E = { profiles: { active: null, isOwner: true } }, S = { signedIn: true, view: "chat" };
  const context = { S, E, MutationObserver, sessionAuthority: pages.pages.sessionAuthority,
    activeId: () => E.profiles?.active?.id ?? null, ownerHere: () => E.profiles?.isOwner === true,
    conversationWho: () => ({ sessionId: sid }), esc: (v) => String(v ?? ""), renderNow() {}, markLive() {},
    on: (name, fn) => { actions[name] = fn; }, toast() {}, Date: Clock,
    openPop: (_el, html) => { pops.push(html); pop = { dataset: {} }; }, closePop: () => { pop = null; },
    openDlg: () => { dlg = {}; }, closeDlg: () => { dlg = null; }, dialog: () => dlg,
    document: { getElementById: () => app, querySelector: (q) => q === "#app > .pop" ? pop : q.includes("context-audit") ? anchor : null }, AbortSignal,
    api: async (_path, body) => { if (body) { posts.push(body); return view; } return held ? held.promise : view; } };
  runInNewContext(`${strip(panelSource)}
globalThis.meter = contextMeter;`, context);
  pages.pages.resetSessionPages(E.profiles);
  return { E, S, app, lockRecords, posts, actions, view, sid, context, reset: (p) => pages.pages.resetSessionPages(p),
    pops, open: () => pop !== null, later: () => { clock += 6000; },
    hold(answer = view) { let resolve; const read = held = { promise: new Promise((done) => { resolve = done; }) };
      read.resolve = () => { held = null; resolve(answer); }; return read; } };
}
const roundtrips = {
  none: () => {},
  "profile away and back": (f) => { const owner = f.E.profiles; f.E.profiles = { active: { id: "sam" }, isOwner: false }; f.reset(f.E.profiles); f.E.profiles = owner; f.reset(owner); },
  "lock and unlock": (f) => { f.lockRecords.push({ oldValue: "locked-b17" }); f.app.locked = false; },
  // Every view change redraws the status bar (shell.js drawAll), so leaving the chat and coming back moves the meter on.
  "view away and back": (f) => { f.S.view = "settings"; f.context.meter(f.sid); f.S.view = "chat"; f.context.meter(f.sid); },
};
for (const [name, change] of Object.entries(roundtrips)) {
  test(`context audit window: ${name} during the confirmation's live read ${name === "none" ? "still writes" : "refuses the write"}`, async () => {
    const f = windowFixture();
    f.context.meter(f.sid);
    await new Promise((resolve) => setImmediate(resolve));
    await f.actions["context-audit"]({ getAttribute: () => "false" });
    f.actions["context-propose"]({ dataset: { request: f.view.requestId, call: "c1" } });
    const read = f.hold(), pending = f.actions["context-confirm"]({ disabled: false });
    change(f); read.resolve(); await pending;
    assert.equal(f.posts.length, name === "none" ? 1 : 0);
  });
}

// Review 5927665125 (branch-coord#1): every read's answer is published only under the authority it was asked with. A
// profile switch away and back, or a lock and unlock, during the meter's first read, its poll, the panel's read or the
// panel's Refresh leaves nothing from before on show: the meter says unknown and the panel closes.
const fresher = (f) => ({ ...f.view, estimated: 500 }), tick = () => new Promise((resolve) => setImmediate(resolve));
const reads = {
  "first read": async (f, change) => { const read = f.hold(fresher(f)); f.context.meter(f.sid); change(f); read.resolve(); await tick(); },
  "poll": async (f, change) => {
    f.context.meter(f.sid); await tick();
    const read = f.hold(fresher(f)); f.later(); f.context.meter(f.sid); change(f); read.resolve(); await tick();
  },
  "panel read": async (f, change) => {
    f.context.meter(f.sid); await tick();
    const read = f.hold(fresher(f)), pending = f.actions["context-audit"]({ getAttribute: () => "false" });
    change(f); read.resolve(); await pending;
  },
  "panel Refresh": async (f, change) => {
    f.context.meter(f.sid); await tick();
    await f.actions["context-audit"]({ getAttribute: () => "false" });
    const read = f.hold(fresher(f)), pending = f.actions["context-refresh"]();
    change(f); read.resolve(); await pending;
  },
};
for (const [where, run] of Object.entries(reads)) for (const name of ["none", "profile away and back", "lock and unlock"]) {
  test(`context audit window: ${name} during the ${where} ${name === "none" ? "shows its answer" : "shows nothing from before"}`, async () => {
    const f = windowFixture();
    await run(f, roundtrips[name]);
    const meter = f.context.meter(f.sid), panel = where.startsWith("panel");
    if (name === "none") {
      assert.match(meter, /Context <\/span>~50%/);
      if (panel) { assert.equal(f.open(), true); assert.match(f.pops.at(-1), /500 \/ 1,000 tokens/); }
    } else {
      assert.match(meter, /Context <\/span>unknown/);
      assert.equal(f.open(), false, "the panel is closed");
      assert.equal(f.pops.some((html) => html.includes("500 / 1,000")), false, "the late answer is never drawn");
    }
  });
}
