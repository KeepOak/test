/* parity-b2: the owner types an address or a search into Branch's browser (POST /api/panels/browse,
   src/owner-browse.ts). It goes through the gate every tool pressed by hand goes through, only for the owner at this
   computer's own window, never while Lockdown is on or a task of the conversation is working, never through a door;
   the window it opens is one run, kept open while the live view reads it and closed once it stops, or on close.
   design/redesign/tools/mutate-live-screen.mjs drops each guard in turn and expects this file to go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, GatewayAuth } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { addressFor, browse, browsedRun, close, browseIdleMs, browseDoorRefusal, browseBusyRefusal } from "../dist/owner-browse.js";
import { setLockdown } from "../dist/lockdown.js";

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-owner-browse-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/* The route's own parts with a stand-in for the gate that counts, runs the page's run the way tryTool does and says "ran". */
function deps(app, over = {}) {
  const gate = { calls: [], signals: [] };
  const base = {
    store: app.store, owner: app.runtime.owner, profiles: { isOwner: () => true }, viaDoor: false, busy: () => false,
    context: (signal) => { gate.signals.push(signal); return { owner: app.runtime.owner, signal }; },
    tryTool: async (context, input, ownRun) => {
      gate.calls.push(input);
      const run = ownRun(input.name, input.arguments.url, input.sessionId);
      run.done(true, "{}");
      return { status: "ran", tool: input.name, target: input.arguments.url, milliseconds: 1, result: { ok: true } };
    },
    ...over,
  };
  return { deps: base, gate };
}

test("an address opens as it is, a site's name as https, and words are searched for on the engine's own page", () => {
  assert.equal(addressFor("https://example.org/a b"), "https://example.org/a b");
  assert.equal(addressFor("example.org/prices"), "https://example.org/prices");
  assert.equal(addressFor("cheapest printer paper"), "https://lite.duckduckgo.com/lite/?q=cheapest%20printer%20paper");
  assert.equal(addressFor("javascript:alert(1)"), "https://lite.duckduckgo.com/lite/?q=javascript%3Aalert(1)", "never a script address");
});

test("a door, anyone but the owner, Lockdown, another's conversation and a working task are refused before the gate", async (t) => {
  const { app } = await world(t);
  const session = app.store.createRun(app.runtime.owner, "Look something up").sessionId;
  app.store.finish(app.store.sessionRuns(app.runtime.owner, session).at(-1).id, "completed", "Done.");
  const input = { sessionId: session, address: "example.org", confirm: false };
  const tried = async (over, status, words) => {
    const { deps: d, gate } = deps(app, over);
    await assert.rejects(browse(d, input), (error) => error.status === status && words.test(error.message));
    assert.equal(gate.calls.length, 0, `nothing reached the gate (${words})`);
  };
  await tried({ viaDoor: true }, 403, new RegExp(browseDoorRefusal.slice(0, 30)));
  await tried({ profiles: { isOwner: () => false } }, 403, /Only the owner/);
  setLockdown(app.store, app.runtime.owner, { on: true });
  await tried({}, 403, /Lockdown is on/);
  setLockdown(app.store, app.runtime.owner, { on: false });
  await tried({ busy: () => true }, 409, new RegExp(browseBusyRefusal.slice(0, 30)));
  await tried({ owner: "somebody-else" }, 404, /not found/);
});

test("the first address makes one run for the window, the next reuses it, and it closes on close or once unread", async (t) => {
  const { app } = await world(t);
  const session = app.store.createRun(app.runtime.owner, "Look something up").sessionId;
  const { deps: d, gate } = deps(app);
  const first = await browse(d, { sessionId: session, address: "example.org", confirm: false });
  assert.equal(first.status, "ran");
  assert.equal(first.url, "https://example.org");
  const runId = browsedRun(session);
  assert.ok(runId, "the window's run is kept for the live view");
  assert.equal(app.store.run(runId).status, "completed", "finished at once: the conversation shows nothing working");
  await browse(d, { sessionId: session, address: "cheap paper", confirm: false });
  assert.equal(browsedRun(session), runId, "the next address opens in the same window");
  assert.equal(app.store.sessionRuns(app.runtime.owner, session).length, 2, "one run for the window, beside the conversation's own");
  assert.equal(gate.calls.map((c) => c.name).join(), "browser.navigate,browser.navigate", "both went through the gate as browser.navigate");
  assert.equal(close(session), true);
  assert.equal(gate.signals[0].aborted, true, "closing it lets its window go");
  assert.equal(browsedRun(session), null);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await browse(d, { sessionId: session, address: "example.org", confirm: false });
  const kept = browsedRun(session);
  t.mock.timers.tick(browseIdleMs - 1000);
  assert.equal(browsedRun(session), kept, "read just before it would close");
  t.mock.timers.tick(2000);
  assert.equal(browsedRun(session), kept, "each read keeps it open for another while");
  t.mock.timers.tick(browseIdleMs + 1);
  assert.equal(browsedRun(session), null, "once nothing reads it, it closes by itself");
  assert.equal(gate.signals.at(-1).aborted, true);
});

test("over HTTP: a short-lived key and a household person are refused, and the owner's address meets the network's rules", async (t) => {
  const { app, root } = await world(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const session = app.store.createRun(app.runtime.owner, "Look something up").sessionId;
  app.store.finish(app.store.sessionRuns(app.runtime.owner, session).at(-1).id, "completed", "Done.");
  const send = (body, token = server.token) => fetch(new URL("/api/panels/browse", server.url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await send({ sessionId: session, address: "example.org" }, key)).status, 401, "a short-lived key");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await send({ sessionId: session, address: "example.org" });
  assert.ok([400, 403].includes(household.status), `a household person (${household.status})`);
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.store.sessionRuns(app.runtime.owner, session).length, 1, "neither made a run");
  // This computer's own address is one the network rules keep a task's browser away from; the owner's typing too.
  const answer = await send({ sessionId: session, address: "http://127.0.0.1:9/" });
  assert.equal(answer.status, 200);
  const outcome = await answer.json();
  assert.ok(["refused", "failed", "asked"].includes(outcome.status), `the address rules decide: ${JSON.stringify(outcome).slice(0, 200)}`);
  assert.notEqual(outcome.status, "ran");
});

test("closing the owner's window is refused through a door, and to anyone but the owner, as opening one is", async (t) => {
  const { app } = await world(t);
  const { deps: d } = deps(app);
  const { closeFor } = await import("../dist/owner-browse.js");
  const sessionId = app.store.createRun(app.runtime.owner, "look").sessionId;
  await browse(d, { sessionId, address: "example.com" });
  assert.ok(browsedRun(sessionId), "open");
  assert.throws(() => closeFor({ viaDoor: true, profiles: app.store.profiles }, sessionId), (error) => error.status === 403 && error.message === browseDoorRefusal);
  assert.ok(browsedRun(sessionId), "still open after the door was refused");
  assert.throws(() => closeFor({ viaDoor: false, profiles: { requireOwner() { throw new Error("Only the owner"); } } }, sessionId), /owner/);
  assert.ok(browsedRun(sessionId), "still open after someone else was refused");
  assert.deepEqual(closeFor({ viaDoor: false, profiles: app.store.profiles }, sessionId), { closed: true });
  assert.equal(browsedRun(sessionId), null);
});

test("over HTTP: closing the owner's browser is refused through the tunnel door, to a paired phone's own key, a short-lived key, a person's key and a household person", async (t) => {
  const { app, root } = await world(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const { deps: d } = deps(app);
  const sessionId = app.store.createRun(app.runtime.owner, "look").sessionId;
  await browse(d, { sessionId, address: "example.com" });
  assert.ok(browsedRun(sessionId), "open");
  t.after(() => close(sessionId));
  const shut = (token = server.token, extra = {}) => fetch(new URL("/api/panels/browse/close", server.url),
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify({ sessionId }) });
  const refused = async (answer, what, check) => {
    const body = await answer.json().catch(() => ({}));
    check(answer.status, body.error ?? "");
    assert.ok(browsedRun(sessionId), `${what}: the window stays open (${answer.status} ${body.error ?? ""})`);
  };
  // A door: the tunnel's mark, and a paired phone's own key even when it arrives from this computer's own address.
  await refused(await shut(undefined, { "x-branch-tunnel": "1" }), "the tunnel door", (status, error) => {
    assert.equal(status, 403); assert.equal(error, browseDoorRefusal);
  });
  const phone = new GatewayAuth(app.store, app.runtime.owner).remember("Robin's phone").key;
  await refused(await shut(phone), "a paired phone's own key", (status, error) => {
    assert.equal(status, 403); assert.equal(error, browseDoorRefusal);
  });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  await refused(await shut(key), "a short-lived key", (status) => assert.equal(status, 401));
  const people = await fetch(new URL("/api/people/settings", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "on" }) });
  assert.equal(people.status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  await refused(await shut(app.people.keys.issue(sam.id, 60, "pin", "test").key), "a person's own key", (status) => assert.ok(status >= 400 && status < 500));
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  await refused(await shut(), "a household person", (status) => assert.ok([400, 403].includes(status)));
  app.store.profiles.switch({ profileId: null });
  // The owner, at this computer's own window, closes it.
  const owner = await shut();
  assert.equal(owner.status, 200);
  assert.deepEqual(await owner.json(), { closed: true });
  assert.equal(browsedRun(sessionId), null);
});
