/**
 * unhold-control: taking over, the tool playground, running a command from the window, and "Ask before
 * opening an app it hasn't used" are live in the window now. Each case here shows the dangerous thing
 * still cannot happen without the engine's own guard. The mutation named on each test is the one that
 * turns it red (each was made in src/, built and seen to fail, then put back).
 *
 * Nothing here opens a window, starts Docker or touches a real screen: the shared Linux desktop is the
 * stand-in tests/shared-desktop.test.mjs uses, and the screen is a recording stand-in runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";
import { newAppHoldReason, saveAppAskSettings, appsUsed } from "../dist/desktop-app-ask.js";

const VIEWER_PASSWORD = "stand-in-viewer-pw-91c";
const exists = (path) => stat(path).then(() => true, () => false);

async function served(t, { shell = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-unhold-control-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // The programs on this computer, as `branch start` sets them up with no launch file; only node is used.
  const integrations = shell ? await loadIntegrations(app.registry, undefined, process.env, app.secretsFor, app.channelHost) : null;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const listeners = [];
  t.after(async () => {
    for (const s of listeners) s.close();
    await server.close(); await integrations?.close(); await app.close(); await discardTemp(root);
  });
  const call = (method, path, key = server.token, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const runKey = () => app.sessionTokens.create(app.runtime.owner, { name: "run", scope: "run", minutes: 5 }).token;
  return { app, server, call, runKey, listeners, workspace: join(root, "workspace") };
}

/** The shared Linux desktop with its docker, password, probe, listener and notice stood in; then started. */
async function standInDesktop({ app, call, listeners }) {
  const desktop = app.linuxDesktop;
  desktop.runner = async (file, args) => (args[0] === "image" ? "ok" : args[0] === "run" ? "abcdef012345\n" : "");
  desktop.feeder = async () => {};
  desktop.spawnerFn = () => ({ stdin: { write() {}, end() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {}, pid: 1 });
  desktop.banner = { async show() {}, async hide() {} };
  desktop.password = () => VIEWER_PASSWORD;
  desktop.pauseMs = 1;
  desktop.probe = async () => true;
  desktop.createListener = () => new Promise((done) => { const s = createServer(); listeners.push(s); s.listen(0, "127.0.0.1", () => done(s)); });
  assert.equal((await call("POST", "/api/linux-desktop", undefined, { mode: "on" })).status, 200);
  await desktop.start(app.runtime.owner);
}

const command = (folder) => ({ name: "shell.execute", arguments: { executable: "node", args: ["-e", `require('fs').mkdirSync('${folder}')`] } });
const byHandRuns = (app) => app.store.runs(app.runtime.owner).filter((r) => r.prompt.startsWith("shell.execute:"));

// Mutation: in src/playground.ts tryTool, delete `if (decision === "deny") return { status: "refused", ... }`.
test("the playground cannot run a tool the owner's policy denies, even when it says it confirmed", async (t) => {
  const f = await served(t);
  assert.equal((await f.call("POST", "/api/policy", undefined, { rules: [{ tool: "files.write", decision: "deny" }] })).status, 200);
  for (const confirm of [false, true]) {
    const tried = await f.call("POST", "/api/tools/try", undefined, { name: "files.write", arguments: { path: "denied.txt", content: "no" }, confirm });
    assert.equal(tried.body.status, "refused", JSON.stringify(tried.body));
  }
  assert.equal(await exists(join(f.workspace, "denied.txt")), false, "nothing was written");
});

// Mutations: in src/playground.ts tryTool, delete `if (decision === "ask" && !input.confirm) return { status: "asked", ... }`
// (the first half goes red); in src/tool-gate.ts manualVerdict, delete the Lockdown hold (`ownerHold`) and
// src/runtime.ts checkPolicy's `lockdownToolRefusal` return (the second half goes red).
test("a command from the window still asks first, runs only after the yes, and is refused under Lockdown", async (t) => {
  const f = await served(t, { shell: true });
  // No approval preset at all ("off"): a command nobody has ruled on still asks (the policy's unmatchedCommands).
  assert.equal((await f.call("POST", "/api/policy", undefined, { preset: "off" })).status, 200);
  const asked = await f.call("POST", "/api/tools/try", undefined, { ...command("asked"), confirm: false });
  assert.equal(asked.body.status, "asked", JSON.stringify(asked.body));
  assert.match(asked.body.question, /Before I go ahead/);
  assert.equal(await exists(join(f.workspace, "asked")), false, "nothing ran before the yes");
  assert.equal(byHandRuns(f.app).length, 0, "no run is made for a question nobody has answered");
  const ran = await f.call("POST", "/api/tools/try", undefined, { ...command("asked"), confirm: true });
  assert.equal(ran.body.status, "ran", JSON.stringify(ran.body));
  assert.equal(await exists(join(f.workspace, "asked")), true);
  // The yes was for that one command: the same command asks again.
  assert.equal((await f.call("POST", "/api/tools/try", undefined, { ...command("again"), confirm: false })).body.status, "asked");
  assert.equal((await f.call("POST", "/api/lockdown", undefined, { on: true })).status, 200);
  const locked = await f.call("POST", "/api/tools/try", undefined, { ...command("locked"), confirm: true });
  assert.equal(locked.body.status, "refused", JSON.stringify(locked.body));
  assert.match(locked.body.reason, /Lockdown is on/);
  assert.equal(await exists(join(f.workspace, "locked")), false, "Lockdown refused it without running it");
});

// Mutation: in src/playground.ts tryToolByHand, drop the last argument (the `handRun` for shell.execute): the
// command fails with "Host commands require an owner and run ID" and there is no run.
test("a command run from the window runs inside a real run of its own, recorded from the window", async (t) => {
  const f = await served(t, { shell: true });
  const ran = await f.call("POST", "/api/tools/try", undefined, { ...command("own-run"), confirm: true });
  assert.equal(ran.body.status, "ran", JSON.stringify(ran.body));
  const [run] = byHandRuns(f.app);
  assert.ok(run, "a run was made for the command");
  assert.equal(run.status, "completed");
  assert.equal(f.app.store.db.prepare("SELECT source FROM tasks WHERE id=?").get(run.id).source, "window");
  assert.equal(run.prompt, "shell.execute: node -e require('fs').mkdirSync('own-run')");
});

// Mutations: in src/playground.ts handSession, return `store.createSession(owner)` every time (new rows appear); drop
// the busy check (the waiting task's transcript gets an "interrupted" tool result written into it). The bound-key case
// is two layers: the app's bound-key check (SessionTokens) already refuses /api/tools/try to a key held to one
// conversation, and the route's own `requireBoundSession` is a second one; the next test proves that one on its own.
test("window commands never fill the side list: kept in their conversation, or one reused Terminal conversation", async (t) => {
  const f = await served(t, { shell: true });
  const { app } = f;
  const owner = app.runtime.owner;
  const rows = async () => (await f.call("GET", "/api/sessions?limit=200")).body.sessions.length;
  const conversation = app.store.createSession(owner);
  const before = await rows();
  for (const folder of ["in-conv-1", "in-conv-2"])
    assert.equal((await f.call("POST", "/api/tools/try", undefined, { ...command(folder), confirm: true, sessionId: conversation })).body.status, "ran");
  assert.equal(await rows(), before, "two commands in the same conversation add no session rows");
  assert.deepEqual(byHandRuns(app).map((r) => r.sessionId), [conversation, conversation], "both kept in that conversation");
  // With no conversation named, one Terminal conversation per person is made once and used again.
  for (const folder of ["loose-1", "loose-2"])
    assert.equal((await f.call("POST", "/api/tools/try", undefined, { ...command(folder), confirm: true })).body.status, "ran");
  assert.equal(await rows(), before + 1, "one Terminal conversation, not one per command");
  const terminal = byHandRuns(app).find((r) => r.sessionId !== conversation).sessionId;
  assert.equal(byHandRuns(app).filter((r) => r.sessionId === terminal).length, 2);
  // A conversation whose task is waiting mid tool call is left alone: the command goes to the Terminal conversation.
  const busy = app.store.createSession(owner);
  app.store.createRun(owner, "a task at work", busy);
  app.store.message(busy, { role: "assistant", content: "", toolCalls: [{ id: "pending-1", name: "files.write", arguments: "{}" }] });
  const transcript = JSON.stringify(app.store.messages(busy));
  assert.equal((await f.call("POST", "/api/tools/try", undefined, { ...command("while-busy"), confirm: true, sessionId: busy })).body.status, "ran");
  assert.equal(JSON.stringify(app.store.messages(busy)), transcript, "the waiting task's transcript is untouched");
  assert.equal(byHandRuns(app)[0].sessionId, terminal, "the newest command went to the Terminal conversation");
  // Somebody else's conversation, or a made-up one, is never written into.
  assert.equal((await f.call("POST", "/api/tools/try", undefined, { ...command("made-up"), confirm: true, sessionId: "00000000-0000-4000-8000-000000000000" })).body.status, "ran");
  assert.equal(byHandRuns(app)[0].sessionId, terminal, "the newest command went to the Terminal conversation");
  // A key bound to one conversation cannot put its command in another.
  const bound = app.sessionTokens.create(owner, { name: "bound", scope: "run", minutes: 5, sessionId: conversation });
  assert.equal(bound.entry.sessionId, conversation);
  const refused = await f.call("POST", "/api/tools/try", bound.token, { ...command("by-bound"), confirm: true, sessionId: busy });
  assert.ok(refused.status >= 400, JSON.stringify(refused.body));
  assert.equal(await exists(join(f.workspace, "by-bound")), false);
});

// The route's own check, with the outer door stood in open: the app's bound-key check (SessionTokens.boundCheck,
// src/people/access.ts boundDoorRefusal) is replaced for this test by one that lets POST /api/tools/try through, as it
// lets /api/run through, so only the route's `requireBoundSession` stands between the key and conversation B.
// Mutation: delete `if (tried.sessionId) requireBoundSession(shortLivedKeyMark().sessionId, tried.sessionId);` in
// src/server.ts (POST /api/tools/try) → the key's command runs and its run lands in B.
test("a key bound to conversation A cannot run a command into conversation B through the playground", async (t) => {
  const f = await served(t, { shell: true });
  const { app } = f;
  const owner = app.runtime.owner;
  // The owner allows commands outright, so the key's command is not stopped by "a key cannot confirm a question" first.
  assert.equal((await f.call("POST", "/api/policy", undefined, { rules: [{ tool: "shell.execute", decision: "allow" }], confirmLoosening: true })).status, 200); // Q257: loosens
  const a = app.store.createSession(owner), b = app.store.createSession(owner);
  const bound = app.sessionTokens.create(owner, { name: "bound", scope: "run", minutes: 5, sessionId: a }).token;
  const runsIn = (sessionId) => byHandRuns(app).filter((r) => r.sessionId === sessionId);
  // With the real door: refused before the route is reached.
  const atDoor = await f.call("POST", "/api/tools/try", bound, { ...command("door-b"), confirm: true, sessionId: b });
  assert.ok(atDoor.status >= 400 && atDoor.status < 500, `${atDoor.status} ${JSON.stringify(atDoor.body)}`);
  // With the door stood in open for this one route: the route refuses it on its own.
  const door = app.sessionTokens.boundCheck;
  app.sessionTokens.boundCheck = (sessionId, method, path) => (method === "POST" && path === "/api/tools/try" ? null : door(sessionId, method, path));
  const refused = await f.call("POST", "/api/tools/try", bound, { ...command("route-b"), confirm: true, sessionId: b });
  assert.ok(refused.status >= 400 && refused.status < 500, `${refused.status} ${JSON.stringify(refused.body)}`);
  assert.match(String(refused.body.error), /only reaches the conversation/);
  assert.deepEqual(runsIn(b), [], "no run landed in B");
  assert.equal(await exists(join(f.workspace, "route-b")), false, "the command did not run");
  // Control: through the open door, the same key in its own conversation does reach the playground and runs there.
  const own = await f.call("POST", "/api/tools/try", bound, { ...command("route-a"), confirm: true, sessionId: a });
  assert.equal(own.body.status, "ran", JSON.stringify(own.body));
  assert.equal(runsIn(a).length, 1, "its run is kept in A");
  assert.deepEqual(runsIn(b), [], "and still none in B");
});

// Mutation: in src/tool-gate.ts manualVerdict, delete `if (check.decision === "ask" && key) return { ... deny ... }`.
test("a short-lived key cannot confirm a command or a playground tool that asks, and cannot take over", async (t) => {
  const f = await served(t, { shell: true });
  await standInDesktop(f);
  const key = f.runKey();
  assert.equal((await f.call("POST", "/api/policy", undefined, { preset: "ask-before-changes" })).status, 200);
  const cmd = await f.call("POST", "/api/tools/try", key, { ...command("by-key"), confirm: true });
  assert.notEqual(cmd.body.status, "ran", JSON.stringify(cmd.body));
  const write = await f.call("POST", "/api/tools/try", key, { name: "files.write", arguments: { path: "by-key.txt", content: "no" }, confirm: true });
  assert.notEqual(write.body.status, "ran", JSON.stringify(write.body));
  assert.equal(await exists(join(f.workspace, "by-key")), false);
  assert.equal(await exists(join(f.workspace, "by-key.txt")), false);
  assert.equal(byHandRuns(f.app).length, 0);
  for (const [method, path] of [["POST", "/api/linux-desktop/take-over"], ["POST", "/api/linux-desktop/hand-back"], ["GET", "/api/linux-desktop/viewer"], ["POST", "/api/desktop/app-ask"]])
    assert.equal((await f.call(method, path, key, method === "POST" ? { on: false } : undefined)).status, 401, `${method} ${path}`);
  assert.equal(f.app.linuxDesktop.controlOf(f.app.runtime.owner), "agent", "the key did not take the desktop");
});

// Mutation: both guards on each route must go for this to go red: add the take-over, hand-back, viewer and
// app-ask routes to src/household-routes.ts householdOwnRoutes AND delete their requireOwner in src/server.ts.
// Either one alone still refuses (defence in depth). The role half: in src/playground.ts tryTool, delete the
// `personRefusal` check AND in src/runtime.ts checkPolicy the `roleRefusal` return (the hand-pressed gate asks
// both). An "adult" household person's role does cover commands, so that person is set up as a "child" here.
test("a household person cannot take over, hand back, read the viewer, change app asking, or go past their role", async (t) => {
  const f = await served(t, { shell: true });
  await standInDesktop(f);
  const sam = (await f.call("POST", "/api/profiles", undefined, { name: "Sam", pin: "2468" })).body;
  f.app.runtime.roles.save(sam.id, { role: "child" });
  assert.equal((await f.call("POST", "/api/profiles/switch", undefined, { profileId: sam.id, pin: "2468" })).status, 200);
  for (const [method, path] of [["POST", "/api/linux-desktop/take-over"], ["POST", "/api/linux-desktop/hand-back"], ["GET", "/api/linux-desktop/viewer"], ["POST", "/api/desktop/app-ask"]]) {
    const answer = await f.call(method, path, undefined, method === "POST" ? { on: true } : undefined);
    assert.ok(answer.status >= 400, `${method} ${path} → ${answer.status}`);
    assert.equal(JSON.stringify(answer.body).includes(VIEWER_PASSWORD), false);
  }
  assert.equal(f.app.linuxDesktop.controlOf(f.app.runtime.owner), "agent");
  const tried = await f.call("POST", "/api/tools/try", undefined, { ...command("by-sam"), confirm: true });
  assert.equal(tried.body.status, "refused", JSON.stringify(tried.body));
  assert.match(tried.body.reason, /Sam is set up as "Child"/);
  const wrote = await f.call("POST", "/api/tools/try", undefined, { name: "files.write", arguments: { path: "by-sam.txt", content: "no" }, confirm: true });
  assert.equal(wrote.body.status, "refused", JSON.stringify(wrote.body));
  assert.equal(await exists(join(f.workspace, "by-sam")), false);
  assert.equal(await exists(join(f.workspace, "by-sam.txt")), false);
  assert.equal(byHandRuns(f.app).length, 0, "no run was made for a refused command");
  assert.equal((await f.call("POST", "/api/profiles/switch", undefined, { profileId: null })).status, 200);
});

// Mutation: in src/playground.ts tryToolByHand, make the run with `app.runtime.owner` instead of
// `app.store.profiles.scope()` (the command then lands in the owner's own list).
test("an adult household person's command runs under their own name, not in the owner's list", async (t) => {
  const f = await served(t, { shell: true });
  const sam = (await f.call("POST", "/api/profiles", undefined, { name: "Sam", pin: "2468" })).body;
  assert.equal((await f.call("POST", "/api/profiles/switch", undefined, { profileId: sam.id, pin: "2468" })).status, 200);
  const scope = f.app.store.profiles.scope();
  assert.notEqual(scope, f.app.runtime.owner);
  const ran = await f.call("POST", "/api/tools/try", undefined, { ...command("by-adult"), confirm: true });
  assert.equal(ran.body.status, "ran", `an adult's role covers commands: ${JSON.stringify(ran.body).slice(0, 300)}`);
  assert.equal(f.app.store.runs(scope).filter((r) => r.prompt.startsWith("shell.execute:")).length, 1, "kept under Sam");
  assert.equal(byHandRuns(f.app).length, 0, "and not in the owner's own runs");
  assert.equal((await f.call("POST", "/api/profiles/switch", undefined, { profileId: null })).status, 200);
});

// Mutation: in src/integrations/linux-desktop.ts status(), return `{ ...infoOf(session), ... }` as well.
test("the viewer password and VNC details reach nobody through the card, and only the owner through the viewer", async (t) => {
  const f = await served(t);
  await standInDesktop(f);
  const card = await f.call("GET", "/api/linux-desktop");
  assert.equal(card.status, 200);
  assert.equal(JSON.stringify(card.body).includes(VIEWER_PASSWORD), false, "the card never carries the password");
  assert.equal("port" in card.body || "host" in card.body, false, "nor where to connect");
  const keyed = await f.call("GET", "/api/linux-desktop", f.runKey());
  assert.equal(JSON.stringify(keyed.body).includes(VIEWER_PASSWORD), false);
  assert.equal((await f.call("GET", "/api/linux-desktop/viewer")).body.password, VIEWER_PASSWORD, "the owner's own viewer route still answers");
  // Take over then hand back, as the window does: the owner holds it, then Branch has it again.
  assert.equal((await f.call("POST", "/api/linux-desktop/take-over")).body.control, "user");
  await assert.rejects(f.app.linuxDesktop.act(f.app.runtime.owner, { type: "key", chord: "Return" }), /let go of it/);
  assert.equal((await f.call("POST", "/api/linux-desktop/hand-back")).body.control, "agent");
});

/** The screen, stood in: DesktopControl with a runner that only records what it was asked to open. */
function standInScreen(app) {
  const opened = [];
  const runner = { async run(kind, payload) { opened.push(payload.app); return { processId: 4242 }; }, async close() {} };
  const screen = new DesktopControl(app.store, { runner, banner: { async show() {}, async hide() {} } });
  return { screen, opened };
}
const ctx = (app, run, trunk) => ({ ...app.runtime.context({ runId: run.id }), ...(trunk ? { trunk } : {}) });

// rw4: a stricter guard ships on. Mutation: in src/desktop-app-ask.ts, set AppAskSettingsSchema's default back to false
// (a fresh engine reads it as off and a new app on the owner's own assistant is let through unasked). The owner's own
// "off" is saved, so it survives a restart; mutation: have saveAppAskSettings save `{}` (the off is not kept).
test("Ask before opening an app it hasn't used ships on, and an owner who turned it off keeps it off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-app-ask-default-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const open = async () => {
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
    const call = (method, path, body) => fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    return { app, call, close: async () => { await server.close(); await app.close(); } };
  };
  let live = await open();
  t.after(async () => { await live?.close(); await discardTemp(root); });
  assert.deepEqual((await live.call("GET", "/api/desktop/app-ask")).body, { on: true }, "never saved: on");
  saveDesktopSettings(live.app.store, live.app.runtime.owner, { enabled: true });
  assert.equal((await live.call("POST", "/api/policy", { preset: "off" })).status, 200);
  const run = live.app.store.createRun(live.app.runtime.owner, "open an app");
  assert.equal(live.app.runtime.checkPolicy("desktop.open", { app: "notepad" }, ctx(live.app, run)).decision, "ask",
    "with nothing saved, a new app is asked about");
  assert.equal((await live.call("POST", "/api/desktop/app-ask", { on: false })).body.on, false);
  assert.deepEqual((await live.call("GET", "/api/desktop/app-ask")).body, { on: false }, "the owner's off is read back");
  await live.close();
  live = await open();
  assert.deepEqual((await live.call("GET", "/api/desktop/app-ask")).body, { on: false }, "and it is still off after a restart");
  const again = live.app.store.createRun(live.app.runtime.owner, "open an app");
  assert.equal(live.app.runtime.checkPolicy("desktop.open", { app: "notepad" }, ctx(live.app, again)).decision, "allow",
    "switched off by the owner, nothing is held");
});

// Mutations: in src/runtime.ts checkPolicy, drop `?? newAppHold(...)` (a new app is no longer asked about);
// in src/integrations/desktop.ts open, drop `noteAppOpened(...)` (the same app on the same Trunk asks again);
// in src/desktop-app-ask.ts, key the record without the Trunk (another Trunk is no longer asked).
test("Ask before opening an app it hasn't used: once per app, per Trunk, and the preset is left alone", async (t) => {
  const f = await served(t);
  const { app } = f;
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  assert.equal((await f.call("POST", "/api/policy", undefined, { preset: "off" })).status, 200);
  assert.equal((await f.call("POST", "/api/desktop/app-ask", undefined, { on: true })).body.on, true);
  const { screen, opened } = standInScreen(app);
  const run = app.store.createRun(app.runtime.owner, "open an app");
  const first = app.runtime.checkPolicy("desktop.open", { app: "notepad" }, ctx(app, run, "trunk-a"));
  assert.equal(first.decision, "ask", "a program Trunk A never opened is asked about");
  assert.match(first.label, new RegExp(newAppHoldReason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(first.remember, "never", "no standing yes is offered for it");
  // The yes: the program starts for Trunk A, and that is what is remembered.
  await screen.open({ app: "notepad" }, ctx(app, run, "trunk-a"));
  assert.deepEqual(opened, ["notepad"]);
  assert.deepEqual(appsUsed(app.store, app.runtime.owner, "trunk-a"), ["notepad"]);
  assert.equal(app.runtime.checkPolicy("desktop.open", { app: "Notepad" }, ctx(app, run, "trunk-a")).decision, "allow", "the same app on the same Trunk is not asked again");
  assert.equal(app.runtime.checkPolicy("desktop.open", { app: "notepad" }, ctx(app, run, "trunk-b")).decision, "ask", "the same app on another Trunk is asked again");
  assert.equal(app.runtime.checkPolicy("desktop.open", { app: "notepad" }, ctx(app, run)).decision, "ask", "and on the owner's own assistant");
  const policy = (await f.call("GET", "/api/policy")).body.policy;
  assert.equal(policy.preset, "off", "the approval preset was not changed");
  assert.deepEqual(policy.rules, [], "and no rule was written");
  // Switched off, nothing is held.
  saveAppAskSettings(app.store, app.runtime.owner, { on: false });
  assert.equal(app.runtime.checkPolicy("desktop.open", { app: "calc" }, ctx(app, run, "trunk-a")).decision, "allow");
});

// End to end on real Trunk turns: a Trunk's turn carries its id to the gate (runtime scopeToSession), so the question,
// the yes and the record are that Trunk's. The screen is the recording stand-in, put in the registry in place of the
// real desktop.open, so nothing is opened on this computer.
// Mutation: in src/runtime.ts scopeToSession, drop `trunk: trunk.trunkId` from the Trunk's context (every Trunk then
// counts as the owner's own assistant, and the second Trunk is not asked).
test("Ask before opening an app it hasn't used, on real Trunk turns: Ada is asked, answered once, then Bo is still asked", async (t) => {
  const { fixture: trunkFixture, on: trunksOn, call: toolCall } = await import("./trunks-helpers.mjs");
  const { app, root } = await trunkFixture(t, [({ last }) => (last?.role === "user" && /open notepad|Yes, go ahead/.test(last.content ?? "") ? toolCall("desktop.open", { app: "notepad" }) : null)]);
  trunksOn(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const post = (path, body) => fetch(server.url + path, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  assert.equal((await post("/api/policy", { preset: "off" })).status, 200);
  assert.equal((await post("/api/desktop/app-ask", { on: true })).body.on, true);
  const { screen, opened } = standInScreen(app);
  const { DesktopOpenSchema } = await import("../dist/integrations/desktop-config.js");
  const permission = app.registry.permissionOf("desktop.open") || "desktop.control";
  app.registry.unregister("desktop.open");
  app.registry.register({ name: "desktop.open", permission, description: "stand-in", parameters: DesktopOpenSchema,
    execute: (input, context) => screen.open(input, context) });
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();

  const first = await app.runtime.run({ prompt: "open notepad", sessionId: ada.chatSessionId });
  assert.equal(first.status, "needs_input", "Ada has never opened notepad, so she asks");
  const waiting = app.runtime.approvals.waiting().find((w) => w.sessionId === ada.chatSessionId);
  assert.ok(waiting, "the question is waiting for the owner");
  assert.match(JSON.stringify(waiting), /not opened this app before/);
  assert.deepEqual(opened, [], "nothing was opened before the yes");
  const yes = await post("/api/policy/approve", { sessionId: ada.chatSessionId, decision: "allow", remember: "never", fingerprint: waiting.fingerprint, carryOn: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  for (let i = 0; i < 100 && !opened.length; i++) await new Promise((done) => setTimeout(done, 50));
  // The carry-on is "Yes, go ahead." in Ada's conversation; the scripted model asks for the same open again.
  assert.deepEqual(opened, ["notepad"], "the yes opened it once");
  assert.deepEqual(appsUsed(app.store, app.runtime.owner, ada.id), ["notepad"], "kept under Ada's id");
  assert.deepEqual(appsUsed(app.store, app.runtime.owner, undefined), [], "not under the owner's own assistant");
  // The carry-on task finishes before Ada is given the next message.
  const busy = () => app.store.runs(app.runtime.owner).some((r) => r.sessionId === ada.chatSessionId && ["running", "queued"].includes(r.status));
  for (let i = 0; i < 200 && busy(); i++) await new Promise((done) => setTimeout(done, 50));

  const again = await app.runtime.run({ prompt: "open notepad", sessionId: ada.chatSessionId });
  assert.equal(again.status, "completed", "Ada is not asked again for notepad");
  assert.deepEqual(opened, ["notepad", "notepad"]);
  const other = await app.runtime.run({ prompt: "open notepad", sessionId: bo.chatSessionId });
  assert.equal(other.status, "needs_input", "Bo has never opened notepad, so he is asked");
  assert.deepEqual(opened, ["notepad", "notepad"]);
  assert.equal(app.store.get("settings", app.runtime.owner, "policy")?.data?.preset, "off", "the approval preset is untouched");
});
