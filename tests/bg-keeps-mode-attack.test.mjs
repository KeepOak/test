/**
 * Redesign security review, adversarial pass on PR #309: tries to get a /bg task out from under the mode of the
 * conversation it was started from. Each case says what it tries and what it expects. A scripted model writes
 * `<tag>.txt` when the prompt says "write <tag>", and waits on a gate when the prompt says "hold"; nothing reaches a
 * provider. Where a case expects the secure outcome and the engine does otherwise, the test fails on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readConversationMode } from "../dist/conversation-mode.js";
import { pickConversationMode } from "../dist/conversation-mode-api.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";

function scripted() {
  let open = null;
  const gate = { held: new Promise((resolve) => { open = resolve; }), release: () => open() };
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
    const text = String(last?.content ?? "");
    if (last?.role === "user" && /\bhold\b/.test(text)) await gate.held;
    const tag = last?.role === "user" ? /\bwrite (\w+)/.exec(text)?.[1] : undefined;
    if (tag) return { content: "", toolCalls: [{ id: `w-${tag}`, name: "files.write", arguments: JSON.stringify({ path: `${tag}.txt`, content: "x" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  return { provider, gate };
}

async function fixture(t, { preset = "off" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-bg-attack-"));
  const { provider, gate } = scripted();
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { gate.release(); await server.close(); await app.close(); await discardTemp(root); });
  const send = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (path, body) => {
    const { status, body: answer } = await send(path, body);
    if (status !== 200) throw new Error(`${status} ${answer.error}`);
    return answer;
  };
  await api("/api/commands/settings", { mode: "on" });
  await api("/api/autonomy/switch", { part: "session-commands", mode: "on" });
  await api("/api/policy", { preset });
  const wrote = (tag) => existsSync(join(workspace, `${tag}.txt`));
  const modeOf = (sessionId) => readConversationMode(app.store, app.runtime.owner, sessionId)?.mode ?? null;
  return { app, api, send, gate, wrote, modeOf };
}

async function settled(app, prompt) {
  for (let tries = 0; tries < 100; tries++) {
    const run = app.store.runs(app.runtime.owner).find((one) => one.prompt === prompt);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`"${prompt}" never settled`);
}
const started = (app, prompt) => app.store.runs(app.runtime.owner).find((one) => one.prompt === prompt);
const bg = (api, body) => api("/api/commands/run", body);

/* ---------- angle 1: the conversation's mode changes after the task starts ---------- */

test("angle 1: tightening the conversation after /bg started does not reach the task; it kept its own copy of the mode", async (t) => {
  const { app, api, gate, wrote, modeOf } = await fixture(t, { preset: "ask-before-changes" });
  const parent = await api("/api/run", { prompt: "Hello", mode: "full" });
  await bg(api, { surface: "window", line: "/bg hold write a1", sessionId: parent.sessionId });
  const task = started(app, "hold write a1");
  pickConversationMode(app, parent.sessionId, "plan");
  gate.release();
  await settled(app, "hold write a1");
  assert.equal(modeOf(task.sessionId), "full", "the task's own conversation kept Full access");
  assert.equal(wrote("a1"), true, "BEHAVIOUR NOTE: the parent's later Plan did not reach the running task");
});

test("angle 1: loosening the conversation after /bg started does not loosen the task", async (t) => {
  const { app, api, gate, wrote } = await fixture(t);
  const parent = await api("/api/run", { prompt: "Hello", mode: "ask" });
  await bg(api, { surface: "window", line: "/bg hold write a2", sessionId: parent.sessionId });
  pickConversationMode(app, parent.sessionId, "full");
  gate.release();
  const run = await settled(app, "hold write a2");
  assert.equal(run.status, "needs_input");
  assert.equal(wrote("a2"), false);
});

test("angle 1: tightening the task's own conversation while it runs applies to its next step", async (t) => {
  const { app, api, gate, wrote } = await fixture(t, { preset: "ask-before-changes" });
  const parent = await api("/api/run", { prompt: "Hello", mode: "full" });
  await bg(api, { surface: "window", line: "/bg hold write a3", sessionId: parent.sessionId });
  pickConversationMode(app, started(app, "hold write a3").sessionId, "plan");
  gate.release();
  await settled(app, "hold write a3");
  assert.equal(wrote("a3"), false, "Plan on the task's own conversation refused the write");
});

/* ---------- angle 2: a Trunk's conversation ---------- */

test("angle 2: /bg from a Trunk's conversation keeps that conversation's mode", async (t) => {
  const { app, api, wrote, modeOf } = await fixture(t);
  for (const part of ["trunks", "conversations"]) app.trunks.setMode(part, { mode: "on" });
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const { sessionId } = await api("/api/trunks/conversations", { trunkId: ann.id });
  await api("/api/conversation-mode", { sessionId, mode: "ask" });
  await bg(api, { surface: "window", line: "/bg write tr1", sessionId });
  const run = await settled(app, "write tr1");
  assert.equal(modeOf(run.sessionId), "ask");
  assert.equal(run.status, "needs_input");
  assert.equal(wrote("tr1"), false);
  // Observation, not a mode bypass: the task runs as the owner's own assistant, not as the Trunk.
  assert.notEqual(app.runtime.trunkShape({ sessionId }), null, "the Trunk's conversation has the Trunk's shape");
  assert.equal(app.runtime.trunkShape({ sessionId: run.sessionId }), null, "OBSERVATION: the /bg task has no Trunk shape");
});

/* ---------- angle 3: chat apps and other surfaces ---------- */

test("angle 3: a chat app cannot run /bg at all, and the HTTP route takes no chat or terminal surface", async (t) => {
  const { app, send } = await fixture(t);
  const parent = await send("/api/run", { prompt: "Hello", mode: "ask" });
  const outcome = await executeCommand(commandHost(app.runtime, app),
    { surface: "chat", line: "/bg write ch1", sessionId: parent.body.sessionId, access: "run" });
  assert.equal(outcome, null, "not a command there");
  for (const surface of ["chat", "terminal"]) {
    const refused = await send("/api/commands/run", { surface, line: "/bg write ch1" });
    assert.equal(refused.status, 400, surface);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(started(app, "write ch1"), undefined, "no background task was started");
});

/* ---------- angle 4: Lockdown ---------- */

test("angle 4: under Lockdown /bg does not start a task, even with a Full access default and a Full access conversation", async (t) => {
  const { app, api, send } = await fixture(t);
  await api("/api/conversation-mode/settings", { newConversation: "full", confirmLoosening: true });
  const parent = await api("/api/run", { prompt: "Hello", mode: "full" });
  await api("/api/lockdown", { on: true });
  assert.equal((await send("/api/run", { prompt: "Hello again", mode: "full" })).status, 403, "control: the window cannot start one either");
  for (const [surface, sessionId, tag] of [["window", undefined, "lk1"], ["window", parent.sessionId, "lk2"], ["phone", undefined, "lk3"]]) {
    const said = await bg(api, { surface, line: `/bg write ${tag}`, ...(sessionId ? { sessionId } : {}) });
    assert.match(said.text, /switched off/, `${surface} ${tag}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const tag of ["lk1", "lk2", "lk3"]) assert.equal(started(app, `write ${tag}`), undefined, tag);
});

test("angle 4: Lockdown switched on while a Full access /bg task runs holds its next write", async (t) => {
  const { app, api, gate, wrote } = await fixture(t);
  const parent = await api("/api/run", { prompt: "Hello", mode: "full" });
  await bg(api, { surface: "window", line: "/bg hold write lk4", sessionId: parent.sessionId });
  await api("/api/lockdown", { on: true });
  gate.release();
  const run = await settled(app, "hold write lk4");
  assert.notEqual(run.status, "completed");
  assert.equal(wrote("lk4"), false);
});

/* ---------- angle 5: a /bg from inside the background conversation ---------- */

test("angle 5: /bg typed inside a background conversation keeps its mode", async (t) => {
  const { app, api, wrote, modeOf } = await fixture(t);
  const parent = await api("/api/run", { prompt: "Hello", mode: "ask" });
  await bg(api, { surface: "window", line: "/bg say hello", sessionId: parent.sessionId });
  const outer = await settled(app, "say hello");
  await bg(api, { surface: "phone", line: "/bg write n1", sessionId: outer.sessionId });
  const inner = await settled(app, "write n1");
  assert.equal(modeOf(inner.sessionId), "ask");
  assert.equal(inner.status, "needs_input");
  assert.equal(wrote("n1"), false);
});

/* ---------- angle 6: session ids, surfaces, a conversation that follows, rooms, bookkeeping ---------- */

test("angle 6: an unknown or malformed sessionId is refused before any task starts", async (t) => {
  const { app, send } = await fixture(t);
  assert.equal((await send("/api/commands/run", { surface: "window", line: "/bg write s1", sessionId: randomUUID() })).status, 404);
  assert.equal((await send("/api/commands/run", { surface: "window", line: "/bg write s1", sessionId: "not-a-uuid" })).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(started(app, "write s1"), undefined);
});

test("angle 6: a surface other than the window cannot shed a conversation's mode", async (t) => {
  const { app, api, send, wrote, modeOf } = await fixture(t);
  const parent = await api("/api/run", { prompt: "Hello", mode: "ask" });
  await bg(api, { surface: "phone", line: "/bg write sp1", sessionId: parent.sessionId });
  const run = await settled(app, "write sp1");
  assert.equal(modeOf(run.sessionId), "ask");
  assert.equal(wrote("sp1"), false);
  // The dashboard does not offer /bg: switched off it is refused, switched on the line is not a command there.
  assert.equal((await send("/api/commands/run", { surface: "dashboard", line: "/bg write sp2", sessionId: parent.sessionId })).status, 404);
  await api("/api/dashboard/settings", { mode: "on" });
  const onDashboard = await send("/api/commands/run", { surface: "dashboard", line: "/bg write sp2", sessionId: parent.sessionId });
  assert.ok(onDashboard.status !== 200 || onDashboard.body.handled === false, JSON.stringify(onDashboard.body));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(started(app, "write sp2"), undefined);
});

test("angle 6 BYPASS: /bg from a conversation that follows the owner's setting takes the looser new-conversation default", async (t) => {
  const { app, api, wrote, modeOf } = await fixture(t, { preset: "ask-before-changes" });
  await api("/api/conversation-mode/settings", { newConversation: "full", confirmLoosening: true });
  const parent = await api("/api/run", { prompt: "Hello", mode: "full" });
  await api("/api/conversation-mode", { sessionId: parent.sessionId, mode: null }); // "Follow my setting" on the chip
  assert.equal(modeOf(parent.sessionId), null);
  // Control: the conversation itself asks before a write.
  const own = await api("/api/run", { prompt: "write f0", sessionId: parent.sessionId });
  assert.equal((await settled(app, "write f0")).status, "needs_input", own.id);
  assert.equal(wrote("f0"), false);
  await bg(api, { surface: "window", line: "/bg write f1", sessionId: parent.sessionId });
  const run = await settled(app, "write f1");
  assert.equal(wrote("f1"), false, `held to the conversation it came from (it was given ${modeOf(run.sessionId)})`);
});

test("angle 6 BYPASS: /bg from a Trunk's side of a room ignores the room's mode, which that side follows", async (t) => {
  const { app, api, wrote, modeOf } = await fixture(t);
  for (const part of ["trunks", "rooms"]) app.trunks.setMode(part, { mode: "on" });
  await api("/api/conversation-mode/settings", { newConversation: "full", confirmLoosening: true });
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  pickConversationMode(app, room.sessionId, "ask");
  const side = room.memberSessions[ann.id];
  assert.equal(app.runtime.modeFollows(side), room.sessionId, "that side follows the room's conversation");
  assert.equal(app.store.ownsSession(app.runtime.owner, side), true, "the HTTP route would accept it");
  await bg(api, { surface: "window", line: "/bg write rm1", sessionId: side });
  const run = await settled(app, "write rm1");
  assert.equal(wrote("rm1"), false, `held to the room's Ask first (it was given ${modeOf(run.sessionId)})`);
});

test("angle 6 BYPASS, default settings: /bg from a conversation that follows a Read only setting asks instead of refusing", async (t) => {
  const { app, api, wrote, modeOf } = await fixture(t, { preset: "read-only" });
  const parent = await api("/api/run", { prompt: "Hello" }); // no mode: it follows the owner's setting, as one begun on the phone does
  assert.equal(modeOf(parent.sessionId), null);
  await api("/api/run", { prompt: "write d0", sessionId: parent.sessionId });
  const own = await settled(app, "write d0");
  assert.notEqual(own.status, "needs_input", "control: the conversation itself refuses the write, it does not ask");
  assert.equal(wrote("d0"), false);
  await bg(api, { surface: "window", line: "/bg write d1", sessionId: parent.sessionId });
  const run = await settled(app, "write d1");
  assert.equal(wrote("d1"), false);
  assert.equal(run.status, own.status, `held to the conversation it came from (it was given ${modeOf(run.sessionId)}, and stopped on ${run.status})`);
});

test("angle 6: another profile's conversation, and /bg while another profile is in use", async (t) => {
  const { app, api, send, wrote, modeOf } = await fixture(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const theirs = await api("/api/run", { prompt: "Hello from Sam" });
  await new Promise((resolve) => setTimeout(resolve, 500)); // filed under Sam, so not in the owner's list
  const whileSam = await send("/api/commands/run", { surface: "window", line: "/bg write pf0" });
  assert.match(whileSam.body.text, /belongs to the owner/, "/bg is the owner's alone");
  app.store.profiles.switch({ profileId: null });
  pickConversationMode(app, theirs.sessionId, "ask");
  const fromOwner = await send("/api/commands/run", { surface: "window", line: "/bg write pf1", sessionId: theirs.sessionId });
  assert.equal(fromOwner.status, 404, "the owner cannot start /bg from Sam's conversation");
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const tag of ["pf0", "pf1"]) assert.equal(started(app, `write ${tag}`), undefined, tag);
  assert.equal(wrote("pf0") || wrote("pf1"), false);
  assert.equal(modeOf(theirs.sessionId), "ask");
});

test("angle 6: at most three background tasks start, even when five /bg arrive at once", async (t) => {
  const { app, api, gate } = await fixture(t);
  const replies = await Promise.all([1, 2, 3, 4, 5].map((n) => bg(api, { surface: "phone", line: `/bg hold race ${n}` })));
  const count = app.store.runs(app.runtime.owner).filter((run) => run.prompt.startsWith("hold race")).length;
  gate.release();
  for (const run of app.store.runs(app.runtime.owner).filter((one) => one.prompt.startsWith("hold race"))) await settled(app, run.prompt);
  const texts = replies.map((reply) => reply.text).join(" | ");
  assert.equal(count, 3, `${count} background tasks started: ${texts}`);
  assert.equal(replies.filter((reply) => /already working/.test(reply.text)).length, 2, texts);
});

