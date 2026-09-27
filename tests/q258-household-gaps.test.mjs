/**
 * Q258: the follow-ups #369 (Q257) left open, closed. A household person at the window (the window switched to their
 * profile) is sent nothing of the owner's in GET /api/state, and `/status` counts only their own work; `/preset` needs
 * the owner's separate yes to loosen, as POST /api/policy does; a room's bare answer is refused when the question has
 * a fingerprint; and each of `mayAnswerHere`'s two narrowing checks, and the waiting-runs filter, decides a case alone.
 *
 * Mutations (each applied to dist/, this file run, the file put back; design/redesign/tools/mutate-q258.mjs), and the
 * case each turns red:
 *   S1  state(): hand everyone ownerStateParts (drop householdStateParts)                  → "GET /api/state"
 *   S2  ownAllowed: keep the owner's whole record (drop the own-task filter)                → "GET /api/state"
 *   S3  household identity: keep the owner's instructions                                   → "GET /api/state"
 *   S4  household memoryProposals: drop the own-task filter                                 → "GET /api/state"
 *   S5  household background: drop the own-task filter                                     → "GET /api/state"
 *   S6  collabState: a household person gets the owner's calendar settings again            → "GET /api/state"
 *   T1  /status: count every waiting question (drop the mayAnswerHere filter)               → "/status"
 *   T2  /status: list every working task (drop the startedForHere filter)                   → "/status"
 *   T3  /status: count as the window for a chat app too (atWindow always true)              → "/status"
 *   P1  /preset: treat every change as confirmed                                            → "/preset"
 *   P2  /preset: drop the refusal throw                                                     → "/preset"
 *   R1  rooms answer: drop the no-fingerprint check                                         → "rooms"
 *   A1  mayAnswerHere: the run-origin check (`personProfileId === person.id`) → true        → "run started for somebody else"
 *   A2  mayAnswerHere: the session check (`ownsSession(scope, sessionId)`) dropped          → "a conversation that is not theirs"
 *   A3  attention(): the household's waiting-runs `.filter(mayAnswerHere)` dropped          → "run started for somebody else"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { choosePreset } from "../dist/terminal-commands.js";
import { mayAnswerHere, startedForHere } from "../dist/household-approvals.js";
import { runOrigin } from "../dist/key-context.js";
import { saveAssistantIdentity } from "../dist/identity.js";
import { statusLines } from "../dist/commands/status.js";
import { commandHost } from "../dist/commands/host.js";
import { call as modelCall, fixture, on } from "./trunks-helpers.mjs";

/** Writes a file when asked; holds a task that says "hang" until it is let go. */
function writer() {
  let release = () => undefined;
  const held = new Promise((resolve) => { release = resolve; });
  const provider = { name: "writer", release, async complete(request) {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    if (last?.role === "user" && /^hang/.test(text)) { await held; return { content: "Done.", toolCalls: [] }; }
    if (last?.role === "user" && /^write /.test(text))
      return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: text.slice(6).trim(), content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  return provider;
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-q258-"));
  const dataDir = join(root, "data");
  const provider = writer();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { provider.release(); app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const call = (method, path, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, text: await response.text() }))
    .then(({ status, text }) => ({ status, text, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() }));
  const asOwner = () => app.store.profiles.switch({ profileId: null });
  const asSam = () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  return { app, call, sam, asOwner, asSam, provider };
}

/** The owner's task waiting on its question, and Sam's own task waiting on his. The window is left on the owner. */
async function waitingWork(app, asOwner, asSam, ownerFile = "owner.txt") {
  asOwner();
  const owners = await app.runtime.run({ prompt: `write ${ownerFile}` });
  const live = app.runtime.approvals.questionFor(owners.sessionId);
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "write sam-own.txt", onTextDelta: () => undefined });
  const mine = app.runtime.approvals.questionFor(sams.sessionId);
  assert.ok(live?.fingerprint && mine?.fingerprint, "control: both tasks ask before writing");
  asOwner();
  return { owners, live, sams, mine };
}

/* S1–S6 */
test("GET /api/state: a household person is sent none of the owner's records or settings, only their own tasks' part", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const owner = app.runtime.owner, mark = "q258canary";
  const { owners, live, sams, mine } = await waitingWork(app, asOwner, asSam, `${mark}-owner.txt`);
  // The owner's own: an answered approval, a project, automations, the assistant's instructions, days off, a
  // suggested memory and a background result from the owner's task.
  app.runtime.approve(owners.sessionId, "allow", "never", live.fingerprint);
  app.store.projects.save(owner, { id: `${mark}-project`, name: `${mark} project` });
  for (const kind of ["schedules", "specialists", "procedures"]) app.store.save(kind, owner, `${mark}-${kind}`, { name: `${mark} ${kind}`, prompt: mark });
  saveAssistantIdentity(app.store, owner, { name: "Branch Agent", instructions: `${mark} instructions`, expectedRevision: 0 });
  app.calendar.configure(owner, { timezone: "Pacific/Chatham", daysOff: ["2031-01-02"] });
  app.store.review.propose(owner, { kind: "put", text: `${mark} memory`, source: "owner", runId: owners.id });
  app.runtime.backgroundResults.unshift({ childRunId: randomUUID(), parentRunId: owners.id, status: "completed", output: `${mark} background`, finishedAt: new Date().toISOString() });
  // Sam's own: his answered question, a suggested memory and a background result from his task.
  asSam();
  assert.equal((await call("POST", "/api/policy/approve", { sessionId: sams.sessionId, decision: "allow", remember: "never", fingerprint: mine.fingerprint })).status, 200);
  asOwner();
  app.store.review.propose(owner, { kind: "put", text: "sam-own memory", source: "sam", runId: sams.id });
  app.runtime.backgroundResults.unshift({ childRunId: randomUUID(), parentRunId: sams.id, status: "completed", output: "sam-own background", finishedAt: new Date().toISOString() });

  const ownerView = (await call("GET", "/api/state")).body;
  const ownerText = JSON.stringify(ownerView);
  for (const what of [`${mark}-owner.txt`, `${mark}-project`, `${mark} schedules`, `${mark} specialists`, `${mark} procedures`, `${mark} instructions`, "Pacific/Chatham", `${mark} memory`, `${mark} background`])
    assert.ok(ownerText.includes(what), `control: the owner's state holds ${what}`);
  assert.ok(ownerView.approvalCategories.length > 0, "control: the owner's approval categories are there");

  asSam();
  const samView = (await call("GET", "/api/state")).body;
  const samText = JSON.stringify(samView);
  assert.equal(samText.includes(mark), false, `nothing of the owner's reaches Sam: ${samText.slice(Math.max(0, samText.indexOf(mark) - 200), samText.indexOf(mark) + 100)}`);
  assert.equal(samText.includes("Pacific/Chatham") || samText.includes("2031-01-02"), false, "the owner's days off and time zone stay theirs");
  assert.deepEqual(samView.approvalCategories, [], "the owner's approval categories are not sent");
  assert.equal(samView.workspace, null, "nor the owner's folder");
  assert.deepEqual(samView.project, { active: null, all: [] });
  for (const key of ["learning", "askFirst", "practice", "reranking", "orchestration", "secondOpinion", "consolidation", "network", "privacy", "skillPolicy"])
    assert.equal(samView[key], null, `the owner's ${key} setting is not sent`);
  for (const key of ["skills", "specialists", "procedures", "schedules", "triggers", "webhooks", "hooks", "setAside", "memoryCheckpoints", "snapshots", "secretReminders", "providerPlugins", "issueTrackers"])
    assert.deepEqual(samView[key], [], `the owner's ${key} are not sent`);
  // His own part is there, and the window's own keys keep their shape.
  assert.ok(samView.allowed.recent.length > 0 && samView.allowed.recent.every((entry) => entry.runId === sams.id), "Sam's record holds his own task only");
  assert.equal(samView.allowed.counts.find((row) => row.action === "approval.decided").count, samView.allowed.recent.filter((entry) => entry.action === "approval.decided").length);
  assert.deepEqual(samView.memoryProposals.map((p) => p.text), ["sam-own memory"]);
  assert.deepEqual(samView.background.map((b) => b.output), ["sam-own background"]);
  assert.equal(samView.identity.name, "Branch Agent", "the assistant's name is still drawn");
  assert.equal(samView.identity.instructions, "");
  assert.ok(samView.runs.some((run) => run.id === sams.id) && !samView.runs.some((run) => run.id === owners.id), "control: runs were already his own");
  assert.equal(samView.collab.calendar.settings, null);
  assert.deepEqual(Object.keys(samView).sort(), Object.keys(ownerView).sort(), "the same keys, so the window draws as it does for the owner");
});

/* T1, T2, T3 */
test("/status: a household person at the window counts only their own questions and working tasks", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners } = await waitingWork(app, asOwner, asSam);
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200, "typed commands on");
  let started;
  const working = app.runtime.run({ prompt: "hang while the owner's task works", onStarted: (run) => { started = run; } });
  for (let i = 0; i < 200 && !(started && app.store.run(started.id)?.status === "running"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.store.run(started.id).status, "running", "control: the owner's task is working");

  const status = async () => (await call("POST", "/api/commands/run", { surface: "window", line: "/status" })).body.text ?? "";
  const ownerSays = await status();
  assert.match(ownerSays, /2 questions wait/, `control: the owner counts both: ${ownerSays}`);
  assert.match(ownerSays, /1 task is working/);
  assert.match(ownerSays, /hang while the owner/);
  asSam();
  const samsWaiting = (await call("GET", "/api/policy")).body.waiting.length;
  assert.equal(samsWaiting, 1, "control: GET /api/policy shows Sam one question");
  const samSays = await status();
  assert.match(samSays, /1 question waits/, `Sam counts only his own question, as GET /api/policy shows him: ${samSays}`);
  assert.match(samSays, /Nothing is working right now/, "the owner's working task is not listed to Sam");
  assert.equal(samSays.includes("hang while the owner"), false, "and its words never reach him");
  // A chat app and the terminal are the owner's: the window being switched to Sam does not narrow them.
  const chat = statusLines({ host: commandHost(app.runtime, app), surface: "chat", argument: "", sessionId: undefined, access: "full", mode: "on" }).join("\n");
  assert.match(chat, /2 questions wait/, `a chat app's /status still counts the owner's: ${chat}`);
  // startedForHere, directly: the owner's task is not Sam's; his own is.
  assert.equal(startedForHere(app.store, started.id), false);
  assert.equal(startedForHere(app.store, owners.id), false);
  asOwner();
  assert.equal(startedForHere(app.store, started.id), true, "control: every task is the owner's to count");
  app.runtime.cancel(started.id);
  await working.catch(() => undefined);
});

/* P1, P2 */
test("/preset: a loosening needs `confirm` after the name, as POST /api/policy needs confirmLoosening", async (t) => {
  const { app, call } = await served(t);
  const preset = () => readPolicy(app.store, app.runtime.owner).preset;
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200, "typed commands on");
  const typed = (line) => call("POST", "/api/commands/run", { surface: "window", line }).then((answer) => answer.body.text ?? answer.text);
  const asked = await typed("/preset off");
  assert.match(asked, /This makes Branch less careful: /, asked);
  assert.match(asked, /Send \/preset off confirm to go ahead\./);
  assert.equal(preset(), "ask-before-changes", "an unconfirmed loosening changes nothing");
  assert.throws(() => choosePreset(app.runtime, "off"), /less careful/, "the terminal's /preset and `branch permissions` are held the same way");
  assert.equal(preset(), "ask-before-changes");
  assert.match(await typed("/preset off please"), /Pick one of/, "only the word confirm goes ahead");
  assert.equal(preset(), "ask-before-changes");
  assert.match(await typed("/preset read-only"), /when to check with me/, "control: tightening needs no yes");
  assert.equal(preset(), "read-only");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  assert.match(await typed("/preset off confirm"), /Lockdown is on/, "under Lockdown even a confirmed loosening is refused");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(preset(), "read-only");
  assert.match(await typed("/preset off confirm"), /when to check with me/, `control: the owner's yes loosens`);
  assert.equal(preset(), "off");
});

/* R1 */
test("rooms: a bare answer is refused when the member's question has a fingerprint, and nothing changes", async (t) => {
  let closeServer = async () => undefined;
  const writesRoomFile = [({ system, last }) => {
    const text = String(last?.content ?? "");
    if (last?.role === "tool") return "Done.";
    if (text.startsWith("[Room") && /write/.test(text) && /\nYou are Ann \(@ann\)/.test(system)) return modelCall("files.write", { path: "room.txt", content: "x" }, `w${randomUUID()}`);
    return text.startsWith("[Room") ? "(pass)" : null;
  }];
  const made = await fixture({ after: (hook) => t.after(async () => { await closeServer(); await hook(); }) }, writesRoomFile);
  const { app } = made;
  on(app, "rooms");
  const server = await startServer(app, { dataDir: join(made.root, "data"), port: 0, host: "127.0.0.1" });
  closeServer = () => server.close();
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, room.sessionId, "ask");
  app.trunks.rooms.send(room.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(room.id);
  const [ask] = app.trunks.rooms.view(room.id).waiting;
  assert.ok(ask?.fingerprint, "control: Ann's question carries a fingerprint");
  const memberSession = room.memberSessions[ann.id];
  const turns = () => app.store.runs(app.runtime.owner).filter((run) => run.sessionId === memberSession).length;
  const before = turns();
  for (const decision of ["allow", "deny"]) {
    const bare = await post(`/api/trunks/rooms/${room.id}/answer`, { memberId: ann.id, decision });
    assert.equal(bare.status, 409, JSON.stringify(bare.body));
    assert.equal(bare.body.error, "Say which request this answer is for: look at what it wants to do now and answer again.");
  }
  await app.trunks.rooms.settled(room.id);
  const view = app.trunks.rooms.view(room.id);
  assert.deepEqual(view.waiting.map((q) => q.fingerprint), [ask.fingerprint], "the question still waits, unchanged");
  assert.deepEqual(app.runtime.allowedNow(memberSession), [], "no yes was kept");
  assert.equal(view.events.find((e) => e.kind === "waiting").answered, undefined, "the room does not mark it answered");
  assert.equal(turns(), before, "no turn was taken again");
  const named = await post(`/api/trunks/rooms/${room.id}/answer`, { memberId: ann.id, decision: "allow", fingerprint: ask.fingerprint });
  assert.equal(named.status, 200, `control: the answer naming its request lands: ${JSON.stringify(named.body)}`);
  await app.trunks.rooms.settled(room.id);
  assert.equal(app.trunks.rooms.view(room.id).waiting.length, 0);
});

/* A1, A3 */
test("mayAnswerHere: a question from a run started for somebody else, sitting in Sam's own conversation, is not his", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live } = await waitingWork(app, asOwner, asSam);
  asSam();
  const samScope = app.store.profiles.scope();
  app.store.reassignSession(owners.sessionId, samScope);
  assert.equal(app.store.ownsSession(samScope, owners.sessionId), true, "control: the conversation is Sam's now, so the session check alone passes");
  assert.equal(runOrigin(app.store, owners.id).personProfileId, null, "control: the run was not started for Sam");
  assert.equal(mayAnswerHere(app.store, { runId: owners.id, sessionId: owners.sessionId }), false, "only the run-origin check refuses it");
  assert.equal((await call("GET", "/api/policy")).body.waiting.some((q) => q.fingerprint === live.fingerprint), false, "GET /api/policy leaves it out");
  const attention = (await call("GET", "/api/state")).body.attention.map((w) => w.runId);
  assert.equal(attention.includes(owners.id), false, "the waiting-runs list leaves it out, though it is in Sam's conversations");
  const answer = await call("POST", "/api/policy/approve", { sessionId: owners.sessionId, decision: "allow", remember: "never", fingerprint: live.fingerprint });
  assert.equal(answer.status, 404, answer.text);
  assert.equal(app.runtime.approvals.questionFor(owners.sessionId, live.fingerprint)?.fingerprint, live.fingerprint, "still waiting");
  asOwner();
  assert.equal(mayAnswerHere(app.store, { runId: owners.id, sessionId: owners.sessionId }), true, "control: the owner answers everything");
});

/* A2 */
test("mayAnswerHere: a run started for Sam, in a conversation that is not theirs, is not his to answer", async (t) => {
  const { app, call, asOwner, asSam, sam } = await served(t);
  const { sams, mine } = await waitingWork(app, asOwner, asSam);
  app.store.reassignSession(sams.sessionId, app.runtime.owner);
  asSam();
  assert.equal(runOrigin(app.store, sams.id).personProfileId, sam.id, "control: the run was started for Sam, so the run-origin check alone passes");
  assert.equal(app.store.ownsSession(app.store.profiles.scope(), sams.sessionId), false, "control: the conversation is not in Sam's scope");
  assert.equal(mayAnswerHere(app.store, { runId: sams.id, sessionId: sams.sessionId }), false, "only the session check refuses it");
  assert.equal((await call("GET", "/api/policy")).body.waiting.some((q) => q.fingerprint === mine.fingerprint), false, "GET /api/policy leaves it out");
  const answer = await call("POST", "/api/policy/approve", { sessionId: sams.sessionId, decision: "allow", remember: "never", fingerprint: mine.fingerprint });
  assert.equal(answer.status, 404, answer.text);
  assert.equal(app.runtime.approvals.questionFor(sams.sessionId, mine.fingerprint)?.fingerprint, mine.fingerprint, "still waiting");
});
