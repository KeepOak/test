/**
 * mac7/lockdown-fix (R17-005), trunks-use-subscriptions: a sign-in account answers a Trunk's work the
 * owner is behind (its conversation, its routines) as it answers the owner, and never work somebody else
 * is behind (a household person, another computer); a key is chosen by the Trunk's own pick, never by
 * the owner's default when it does not copy them. Every service is a stand-in: keys are answered by a fake fetch, programs by a fake runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updateAccount, updatePool } from "../dist/accounts/manage.js";
import { asPerson } from "../dist/people/context.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-accounts-trunks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy; // the stand-in fetch below is the whole network
  for (const part of ["trunks", "rooms", "routines"]) app.trunks.setMode(part, { mode: "on" });
  return { app, service, owner: app.runtime.owner };
}
/** A saved key connection: its first key is a stand-in provider, the second answers through a fake fetch. */
function apiConnection(fx, { active = true } = {}) {
  const { app, owner, service } = fx;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const calls = { first: 0, second: 0 };
  const provider = { name: "openai-chat", complete: async () => { calls.first++; return { content: "from the first key", toolCalls: [] }; } };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider });
  if (active) app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (_url, init) => {
    calls.second++;
    if (JSON.parse(String(init.body)).stream) {
      const chunk = JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "from the second key" }, finish_reason: "stop" }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}
/** An installed program signed in to the owner's own account. */
function program(fx) {
  const seen = [];
  const spawn = async (_row, _prompt, _signal, _limits, home) => {
    seen.push(home?.path ?? "primary");
    return { code: 0, stdout: JSON.stringify({ result: "from the sign-in" }), stderr: "" };
  };
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" }, {}, spawn);
  fx.service.deps.spawnAgent = spawn;
  return seen;
}
const accountOf = (app, runId) => app.store.events(runId).filter((e) => e.kind === "model.account").map((e) => e.data.account);

test("a Trunk's pick answers in its conversation, its routine and its room seat, not the owner's default", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  apiConnection(fx);
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  const ed = app.trunks.create({ name: "Ed" });
  const flo = app.trunks.create({ name: "Flo" });
  app.trunks.edit(ed.id, { permissions: ["files.read"], keys: { copyFromOwner: true, accounts: { [POOL]: second } } });
  await app.trunks.introduced();

  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.output, "from the first key", "the owner's own task keeps the default key");
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.output, "from the second key");

  const routine = app.trunks.routines.create(ed.id, { name: "Look", prompt: "Look around" });
  const fired = await app.scheduler.trigger(owner, routine.id, null, owner);
  const routineRun = app.store.run(fired.id) ?? fired;
  assert.notEqual(routineRun.sessionId, ed.chatSessionId, "a routine runs in a conversation of its own");
  const settled = await waitFor(() => { const r = app.store.run(fired.id); return r && r.status !== "running" ? r : null; });
  assert.deepEqual(accountOf(app, settled.id), [second], "the routine used the Trunk's pick, with no conversation choice to go on");

  const room = app.trunks.rooms.create({ name: "Pair", members: [ed.id, flo.id] });
  app.trunks.rooms.send(room.id, { text: "@ed say something" });
  await app.trunks.rooms.settled(room.id);
  const seat = app.store.runs(owner).find((run) => run.sessionId === room.memberSessions[ed.id]);
  assert.ok(seat, "Ed spoke in the room");
  assert.deepEqual(accountOf(app, seat.id), [second], "the room seat used the Trunk's pick too");
});

test("trunks-use-subscriptions: the owner's Trunk answers through the owner's sign-in, in its conversation and its routine", async (t) => {
  for (const accounts of ["off", "on"]) {
    await t.test(`several accounts ${accounts}`, async (t) => {
      const fx = await fixture(t);
      const { app, service, owner } = fx;
      const seen = program(fx);
      app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
      setMode(service, { mode: accounts });
      if (accounts === "on") await addAccount(service, { pool: "cli-claude-code", label: "Second" });
      const ed = app.trunks.create({ name: "Ed" });
      await app.trunks.introduced();
      const before = seen.length;
      const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
      assert.equal(chat.status, "completed", chat.output);
      assert.equal(chat.output, "from the sign-in");
      const routine = app.trunks.routines.create(ed.id, { name: "Look", prompt: "Look around" });
      const fired = await app.scheduler.trigger(owner, routine.id, null, owner);
      const done = await waitFor(() => { const r = app.store.run(fired.id); return r && r.status !== "running" ? r : null; });
      assert.equal(done.output, "from the sign-in", "the owner's routine for the Trunk uses the sign-in too");
      assert.equal(seen.length, before + 2, "the program answered both");
      // The usage meter counts the account that answered, as for the owner's own work.
      if (accounts === "on") assert.deepEqual(accountOf(app, chat.id), ["primary"]);
    });
  }
});

test("trunks-use-subscriptions: work somebody else is behind never reaches the owner's sign-in, even with one account", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const seen = program(fx);
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  const before = seen.length;
  // A message from a Trunk on another computer (src/reach/trunk-roster.ts) arrives as source "a2a".
  const remote = await app.runtime.run({ prompt: "A message from the Trunk ann-laptop:\n\nhello", sessionId: ed.chatSessionId, source: "a2a" });
  assert.equal(remote.status, "failed");
  assert.match(remote.output, /A Trunk answers through your sign-in accounts only for your own work/);
  // A household person's message in a room the Trunk sits in.
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const flo = app.trunks.create({ name: "Flo" });
  const room = app.trunks.rooms.create({ name: "Pair", members: [ed.id, flo.id], people: [sam.id] });
  app.trunks.rooms.send(room.id, { text: "@ed say something" }, { id: sam.id, name: "Sam" });
  await app.trunks.rooms.settled(room.id);
  const seat = app.store.runs(owner).find((run) => run.sessionId === room.memberSessions[ed.id]);
  assert.ok(seat, "Ed was asked in the room");
  assert.equal(seat.status, "failed", seat.output);
  assert.match(seat.output, /only for your own work/);
  assert.equal(seen.length, before, "the program was never started for somebody else");
  // The window's list says the same for whoever asks: the owner may, a household person may not.
  const use = () => app.runtime.models.summary(owner).presets.find((p) => p.id === "cli-claude-code").trunkUse;
  assert.deepEqual(use(), { ok: true });
  const asked = asPerson({ profileId: sam.id, keyId: "test" }, use);
  assert.equal(asked.ok, false);
  assert.match(asked.reason, /only for your own work/);
});

test("trunks-use-subscriptions: work somebody else is behind skips a sign-in first in the list, and a key answers", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const seen = program(fx);
  const calls = apiConnection(fx, { active: false });
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code", fallbackOrder: [POOL] });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  const before = seen.length;
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId, source: "a2a" });
  assert.equal(chat.output, "from the first key");
  assert.equal(seen.length, before);
  assert.ok(calls.first >= 1);
});

test("trunks-use-subscriptions: a Trunk's plan limit stops it, and sharing moves it only to an account kept separate", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  const seen = [];
  const spawn = async (_row, _prompt, _signal, _limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    if (who === "primary") return { code: 1, stdout: "", stderr: "Claude usage limit reached. Your limit resets at 3pm." };
    return { code: 0, stdout: JSON.stringify({ result: `from ${who}` }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  service.deps.spawnAgent = spawn;
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: "cli-claude-code", label: "Second" })).accounts.at(-1).id;
  const work = (await addAccount(service, { pool: "cli-claude-code", label: "Work" })).accounts.at(-1).id;
  await updateAccount(service, { pool: "cli-claude-code", account: work, keptSeparate: true });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  // Sharing off: the limit stops the Trunk and says so; nothing moves by itself.
  const stopped = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.output, /has reached its plan limit/);
  assert.deepEqual(accountOf(app, stopped.id), []);
  // Sharing on: the work moves to the account kept separate, never to the owner's second plan.
  updatePool(service, { pool: "cli-claude-code", autoSwitch: true });
  const moved = await app.runtime.run({ prompt: "hello again", sessionId: ed.chatSessionId });
  assert.equal(moved.status, "completed", moved.output);
  assert.deepEqual(accountOf(app, moved.id), [work]);
  assert.ok(!seen.some((who) => who.includes(second)), "the owner's second plan was never used");
});

test("trunks-use-subscriptions: a Trunk that does not copy the owner's accounts uses only the sign-in picked for it", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  const seen = program(fx);
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: "cli-claude-code", label: "Second" })).accounts.at(-1).id;
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: {} } });
  await app.trunks.introduced();
  const before = seen.length;
  const refused = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(refused.status, "failed");
  assert.match(refused.output, /does not copy your keys and has no key picked for cli-claude-code/);
  assert.equal(seen.length, before, "the owner's default sign-in was not used");
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: { "cli-claude-code": second } } });
  const picked = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(picked.status, "completed", picked.output);
  assert.deepEqual(accountOf(app, picked.id), [second]);
});

test("a Trunk that does not copy the owner's keys and has no pick is refused rather than using the default", async (t) => {
  const fx = await fixture(t);
  const { app, service } = fx;
  const calls = apiConnection(fx);
  setMode(service, { mode: "on" });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: {} } });
  await app.trunks.introduced();
  const before = calls.first;
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.status, "failed");
  assert.match(chat.output, /does not copy your keys and has no key picked for openai-test/);
  assert.equal(calls.first, before, "the owner's default key was not used");
});

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
