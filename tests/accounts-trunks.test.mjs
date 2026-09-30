/**
 * mac7/lockdown-fix (R17-005), trunks-use-subscriptions: a sign-in account answers a Trunk's work the
 * owner is behind (its conversation, its routines) as it answers the owner, and never work somebody else
 * is behind (a household person, another computer); a key is chosen by the Trunk's own pick, never by
 * the owner's default when it does not copy them. Every service is a stand-in: keys are answered by a fake fetch, programs by a fake runner.
 */
import test from "node:test";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updatePool } from "../dist/accounts/manage.js";
import { asPerson } from "../dist/people/context.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-accounts-trunks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });
  await fakeClaudeAccounts(t, service);
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
  assert.equal(seen.length, before, "the program was never started for the other computer's Trunk");
  // A household person's message in a room the Trunk sits in.
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const flo = app.trunks.create({ name: "Flo" });
  // Flo introducing itself to the owner is the owner's own work (Trunk conversations ship on), so it is counted first.
  await app.trunks.introduced();
  const beforeRoom = seen.length;
  const room = app.trunks.rooms.create({ name: "Pair", members: [ed.id, flo.id], people: [sam.id] });
  app.trunks.rooms.send(room.id, { text: "@ed say something" }, { id: sam.id, name: "Sam" });
  await app.trunks.rooms.settled(room.id);
  const seat = app.store.runs(owner).find((run) => run.sessionId === room.memberSessions[ed.id]);
  assert.ok(seat, "Ed was asked in the room");
  assert.equal(seat.status, "failed", seat.output);
  assert.match(seat.output, /only for your own work/);
  assert.equal(seen.length, beforeRoom, "the program was never started for somebody else");
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

test("trunks-use-subscriptions: a Trunk's plan limit stops it with moving on off, and moves it to the owner's next account with it on", async (t) => {
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
  // long-work: sharing ships on, so it is switched off here first, before the Trunk's first words pick an account.
  updatePool(service, { pool: "cli-claude-code", autoSwitch: false });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  // Sharing off: the limit stops the Trunk and says so; nothing moves by itself.
  const stopped = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.output, /has reached its plan limit/);
  assert.deepEqual(accountOf(app, stopped.id), []);
  // Moving on (account pools, 2026-09-27): the next account in the list's order takes it, the owner's own plans included.
  updatePool(service, { pool: "cli-claude-code", autoSwitch: true });
  const moved = await app.runtime.run({ prompt: "hello again", sessionId: ed.chatSessionId });
  assert.equal(moved.status, "completed", moved.output);
  assert.deepEqual(accountOf(app, moved.id), [second]);
  assert.ok(!seen.some((who) => who.includes(work)), "fill first: the next in order, not the last");
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
  assert.match(refused.output, /does not copy your accounts and has no account picked for Claude Code \(installed on this computer\)\. Pick one for it in Edit Trunk › Accounts/);
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
  assert.match(chat.output, /does not copy your accounts and has no account picked for OpenAI test/);
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

test("trunks-use-subscriptions: Claude Code answering a Trunk gets no tools of its own; the owner's own call is unchanged", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const args = [];
  const spawn = async (row) => { args.push(row.args); return { code: 0, stdout: JSON.stringify({ result: "from the sign-in" }), stderr: "" }; };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  fx.service.deps.spawnAgent = spawn;
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  args.length = 0;
  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.output, "from the sign-in");
  assert.equal(args[0][args[0].indexOf("--tools") + 1], "", "the owner's transport delegates every tool to Branch");
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.output, "from the sign-in", chat.output);
  assert.equal(args[1][args[1].indexOf("--tools") + 1], "", "Claude Code runs with no tools of its own for a Trunk");
});

test("trunks-use-subscriptions: a Trunk messaged by a Trunk a household person drove is not the owner's work", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const seen = program(fx);
  app.trunks.setMode("messages", { mode: "on" });
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const ed = app.trunks.create({ name: "Ed" }), flo = app.trunks.create({ name: "Flo" });
  await app.trunks.introduced();
  const send = async (who) => {
    const as = (work) => (who ? asPerson({ profileId: who, keyId: "test" }, work) : work());
    const sender = await as(() => app.runtime.run({ prompt: "tell flo", sessionId: ed.chatSessionId }));
    const toFlo = () => app.store.runs(owner).filter((r) => r.sessionId === flo.chatSessionId && r.prompt.startsWith("Message from"));
    const earlier = new Set(toFlo().map((r) => r.id));
    // The tool call runs inside the sender's own task, so as whoever that task is for.
    as(() => app.trunks.messages.send({ owner, runId: sender.id, agent: `trunk:${ed.id}`, permissions: new Set(["trunks.message"]) }, { to: "@flo", message: "hello" }));
    return waitFor(() => toFlo().find((r) => !earlier.has(r.id) && r.status !== "running") ?? null);
  };
  const owners = await send(null);
  assert.equal(owners.output, "from the sign-in", "the owner's Trunk-to-Trunk message answers through the sign-in");
  await waitFor(() => app.store.runs(owner).filter((r) => r.sessionId === ed.chatSessionId).length >= 2
    && app.store.runs(owner).every((r) => r.status !== "running")); // Flo's reply reaches Ed first
  const before = seen.length;
  const sams = await send(sam.id);
  assert.equal(sams.status, "failed", sams.output);
  assert.match(sams.output, /only for your own work/);
  assert.equal(seen.length, before, "the sign-in never answered the message Sam's work sent");
});

test("trunks-use-subscriptions: a schedule a Trunk made during a household person's work runs as them, never on the owner's sign-in", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const seen = program(fx);
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  const make = async (who) => {
    const start = () => app.runtime.run({ prompt: "check later", sessionId: ed.chatSessionId });
    const made = await (who ? asPerson({ profileId: who, keyId: "test" }, start) : start());
    const context = { owner, runId: made.id, trunk: ed.id, permissions: new Set(["schedules.manage", "files.read"]) };
    const record = app.scheduler.create(context, { prompt: "Look around", kind: "task", dueAt: new Date(Date.now() + 3_600_000).toISOString() });
    return app.scheduler.trigger(owner, record.id, null, "local");
  };
  const owners = await make(null);
  assert.equal(owners.output, "from the sign-in", "a schedule the owner's Trunk made keeps the owner's sign-in");
  const before = seen.length;
  const sams = await make(sam.id);
  assert.equal(sams.status, "failed", sams.output);
  assert.match(sams.output, /only for your own work/);
  assert.equal(seen.length, before, "the sign-in never answered the schedule made during Sam's work");
});

test("owner priority 2026-09-27: one Trunk answers with the owner's second Codex account, another with a second Claude account, the owner keeps the first", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  const seen = [];
  const spawn = async (row, _prompt, _signal, _limits, home) => {
    seen.push({ program: row.id, home: home?.path ?? "primary" });
    return row.id === "codex"
      ? { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "from codex" } }), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ result: "from claude" }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "codex" }, {}, spawn);
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  service.deps.spawnAgent = spawn;
  // Codex counts as installed only when it is on PATH (checkProgram), which a build machine's is not: the Claude
  // transport reads every sign-in before it answers, and a Codex that is not there reads as signed out.
  const bin = await mkdtemp(join(tmpdir(), "codex-fixture-bin-")), before = process.env.PATH;
  for (const name of ["codex", "codex.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  process.env.PATH = bin + (process.platform === "win32" ? ";" : ":") + before;
  t.after(async () => { process.env.PATH = before; await discardTemp(bin); });
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  setMode(service, { mode: "on" });
  const codexSecond = (await addAccount(service, { pool: "cli-codex", label: "Work Codex" })).accounts.at(-1).id;
  const claudeSecond = (await addAccount(service, { pool: "cli-claude-code", label: "Work Claude" })).accounts.at(-1).id;
  const coder = app.trunks.create({ name: "Coder" });
  const writer = app.trunks.create({ name: "Writer" });
  app.trunks.edit(coder.id, { model: "cli-codex", keys: { copyFromOwner: true, accounts: { "cli-codex": codexSecond } } });
  app.trunks.edit(writer.id, { model: "cli-claude-code", keys: { copyFromOwner: true, accounts: { "cli-claude-code": claudeSecond } } });
  await app.trunks.introduced();

  const coded = await app.runtime.run({ prompt: "hello", sessionId: coder.chatSessionId });
  assert.equal(coded.status, "completed", coded.output);
  assert.equal(coded.output, "from codex");
  assert.deepEqual(seen.at(-1), { program: "codex", home: service.homeOf("cli-codex", codexSecond) }, "Codex, in the picked account's own folder");
  assert.deepEqual(accountOf(app, coded.id), [codexSecond]);

  const written = await app.runtime.run({ prompt: "hello", sessionId: writer.chatSessionId });
  assert.equal(written.status, "completed", written.output);
  assert.equal(written.output, "from claude");
  assert.deepEqual(seen.at(-1), { program: "claude-code", home: service.homeOf("cli-claude-code", claudeSecond) }, "Claude Code, in the picked account's own folder");
  assert.deepEqual(accountOf(app, written.id), [claudeSecond]);

  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.output, "from claude");
  assert.deepEqual(seen.at(-1), { program: "claude-code", home: "primary" }, "the owner's own work keeps the owner's first account");
});

test("models-ui: a Trunk at its account's limit goes on to its own next account, never the owner's when it does not copy them, and the owner is told", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  const seen = [];
  let limited = new Set();
  const spawn = async (_row, _prompt, _signal, _limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    if (limited.has(who)) return { code: 1, stdout: "", stderr: "Claude usage limit reached. Your limit resets at 3pm." };
    return { code: 0, stdout: JSON.stringify({ result: `from ${who}` }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  service.deps.spawnAgent = spawn;
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
  setMode(service, { mode: "on" });
  const work = (await addAccount(service, { pool: "cli-claude-code", label: "Work" })).accounts.at(-1).id;
  const spare = (await addAccount(service, { pool: "cli-claude-code", label: "Spare" })).accounts.at(-1).id;
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: { "cli-claude-code": work }, next: { "cli-claude-code": [spare] } } });
  await app.trunks.introduced();

  limited = new Set([work]);
  const moved = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(moved.status, "completed", moved.output);
  assert.equal(moved.output, `from ${spare}`, "its own next account took it");
  assert.ok(!seen.includes("primary"), "the owner's own account is never spent for a Trunk that does not copy it");
  const told = service.trunkMoves[0];
  assert.deepEqual({ from: told.from, to: told.to, session: told.sessionId }, { from: "Work", to: "Spare", session: ed.chatSessionId });
  assert.match(told.why, /plan limit|limit/i);

  // Both of its own at their limit: it stops and says so, still without touching the owner's.
  limited = new Set([work, spare]);
  const before = seen.length;
  const stopped = await app.runtime.run({ prompt: "hello again", sessionId: ed.chatSessionId });
  assert.equal(stopped.status, "failed");
  assert.ok(!seen.slice(before).includes("primary"));
});
