/**
 * Q259: a household person at the window (the window switched to their profile) acts only on their own things through
 * typed commands and the routes around them.
 *
 * - /stop finds and stops only tasks started for them in their own conversations; the owner's task id reads exactly
 *   like an id that does not exist, and the owner's task keeps working. Their own task stops, by id and bare.
 * - POST /api/commands/run takes their own conversation (lent to the owner while their task works) and refuses the
 *   owner's with the same 404 as a conversation that does not exist.
 * - Every command not listed as theirs is refused at the window; the owner's saved commands are no commands for them.
 *   /sessions, /status, /usage, /memory and /whoami are narrowed to them. The terminal still acts as the owner.
 * - GET /api/policy sends them no policy; GET /api/approvals/categories none of the owner's rules.
 * - GET /api/audit and its spreadsheet, GET /api/usage and its spreadsheet, GET /api/prompts: their own part only.
 * - /inspect, /steps, /trajectory and the Markdown export find only their own; doing a task again is the owner's;
 *   the pairing link, the owner's morning brief and research reports are refused to them.
 * - branch run --preset/--save-preset are refused under Lockdown; --save-preset needs --confirm to loosen;
 *   branch permissions says `branch permissions <name> confirm`.
 *
 * Mutations (each applied to dist/, this file run, the file put back), and the case each turns red:
 *   S1  runsHere: return every owner task for a household person too                     → "cannot stop the owner's task"
 *   S2  runsHere: no task at all for a household person                                   → "stops their own task"
 *   S3  personConversation: drop the lent-conversation branch                             → "stops their own task"
 *   S4  commands api run(): check the conversation against the owner again                → "conversation check"
 *   S5  executeCommand: delete the household command refusal                              → "only their commands"
 *   S6  executeCommand: run the owner's saved commands for a household person            → "only their commands"
 *   S7  householdHere: true on every surface (the terminal too)                           → "terminal acts as the owner"
 *   S8  /sessions: search the owner's tasks again                                         → "narrowed commands"
 *   S9  /status: keep the owner's "When to check with you" line                           → "narrowed commands"
 *   S10 /usage: keep the owner's month                                                    → "narrowed commands"
 *   S11 /memory: read the owner's facts                                                   → "narrowed commands"
 *   S12 GET /api/policy: send the owner's policy to everyone                              → "policy and categories"
 *   S13 GET /api/approvals/categories: the owner's categories to everyone                 → "policy and categories"
 *   S14 GET /api/audit: the owner's whole record to everyone                              → "audit"
 *   S15 the audit spreadsheet: the owner's whole record to everyone                       → "audit"
 *   S16 GET /api/usage: the owner's usage to everyone                                     → "usage and prompts"
 *   S17 GET /api/prompts: the owner's saved prompts to everyone                           → "usage and prompts"
 *   S18 /inspect: find the owner's task for anybody                                       → "task details"
 *   S19 /replay: no owner check                                                           → "task details"
 *   S20 Markdown export: read the owner's conversation for anybody                        → "task details"
 *   S21 pairing link: not refused to a household person                                   → "task details"
 *   S22 usePreset: no Lockdown check                                                      → "branch run presets"
 *   S23 usePreset: every --save-preset counted as confirmed                               → "branch run presets"
 *   S24 branch permissions: the /preset words again                                       → "branch permissions"
 *   S25 GET /api/commands: the owner's saved commands listed for a household person       → "only their commands"
 *   S26 /steps and /trajectory: find the owner's task for anybody                         → "task details"
 *   S27 the owner's morning brief and research reports: not refused to a household person → "task details"
 * Run them all: node design/redesign/tools/mutate-q259.mjs (after npx tsc -p .).
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
import { setLockdown } from "../dist/lockdown.js";
import { audit } from "../dist/audit.js";
import { savePrompt, savePromptLibrarySettings } from "../dist/prompt-library.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { parseRunArgs, usePreset } from "../dist/cli-run.js";
import { runTerminalCommand } from "../dist/terminal-cli.js";

const refusal = "This belongs to the owner. Switch back to the owner's profile to use it.";
const noSuchTask = "No working task has that id. Send /status to see what is working.";

/** Holds a task that says "hang" until it is let go (for good); writes a file when asked; otherwise says it is done. */
function model() {
  const held = [];
  let free = false;
  const provider = { name: "q259", release: () => { free = true; held.splice(0).forEach((go) => go()); }, async complete(request) {
    const last = request.messages.at(-1), text = String(last?.content ?? "");
    if (!free && last?.role === "user" && /^hang/.test(text)) await new Promise((go) => held.push(go));
    if (last?.role === "user" && /^write /.test(text))
      return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: text.slice(6).trim(), content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  return provider;
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-q259-"));
  const dataDir = join(root, "data"), provider = model();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
  const server = await startServer(app, { dataDir, port: 0 });
  const running = [];
  t.after(async () => {
    provider.release(); app.store.profiles.switch({ profileId: null });
    await Promise.allSettled(running); await server.close(); await app.close(); await discardTemp(root);
  });
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
  const typed = (line, sessionId, surface = "window") => call("POST", "/api/commands/run", { surface, line, ...(sessionId ? { sessionId } : {}) });
  /** Starts a task that keeps working until the test ends, for whoever is at the window; resolves once it works. */
  const working = async (prompt = "hang") => {
    let started;
    const person = !app.store.profiles.isOwner();
    const done = (person ? runForCurrentPerson(app, { prompt, onTextDelta: () => undefined, onStarted: (run) => { started = run; } })
      : app.runtime.run({ prompt, onStarted: (run) => { started = run; } })).catch(() => undefined);
    running.push(done);
    for (let i = 0; i < 300 && !(started && app.store.run(started.id)?.status === "running"); i++) await new Promise((go) => setTimeout(go, 10));
    assert.equal(app.store.run(started.id)?.status, "running", "control: the task is working");
    return started;
  };
  /**
   * Lets every held task answer and waits for each to end. A stopped task ends "cancelled"; one nobody stopped ends
   * "completed". (Once a model call has been out for a while the engine writes the stop down only when it returns.)
   */
  const finished = async () => { provider.release(); await Promise.allSettled(running); };
  asOwner();
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200);
  return { app, call, sam, asOwner, asSam, typed, working, finished, provider };
}

/* S1 */
test("a household person cannot stop the owner's task with /stop <id>, and it keeps working", async (t) => {
  const { app, asOwner, asSam, typed, working, finished } = await served(t);
  const owners = await working("hang owner's");
  const control = await working("hang control");
  asSam();
  const byId = await typed(`/stop ${owners.id.slice(0, 8)}`);
  assert.equal(byId.status, 200);
  assert.deepEqual({ text: byId.body.text, command: byId.body.command }, { text: noSuchTask, command: "stop" }, "reads like no such task");
  const madeUp = await typed(`/stop ${randomUUID().slice(0, 8)}`);
  assert.equal(madeUp.body.text, byId.body.text, "the owner's id and a made-up id read the same");
  const bare = await typed("/stop", owners.sessionId);
  assert.deepEqual([bare.status, bare.body], [404, { error: "Conversation not found" }], "bare /stop in the owner's conversation is refused");
  assert.equal(app.store.run(owners.id).status, "running", "the owner's task is still working");
  asOwner();
  assert.match((await typed(`/stop ${control.id.slice(0, 8)}`)).body.text, /^Stopping/, "control: the owner stops their own");
  await finished();
  assert.equal(app.store.run(owners.id).status, "completed", "the owner's task was never stopped: it finished");
  assert.equal(app.store.run(control.id).status, "cancelled", "control: the one the owner stopped ends stopped");
});

/* S2, S3 */
test("a household person stops their own task: bare /stop in their conversation, and /stop <id>", async (t) => {
  const { app, asSam, typed, working, finished } = await served(t);
  asSam();
  const first = await working("hang one");
  assert.equal(app.store.ownsSession(app.store.profiles.scope(), first.sessionId), false, "control: it is lent to the owner while it works");
  const bare = await typed("/stop", first.sessionId);
  assert.equal(bare.status, 200, bare.text);
  assert.match(bare.body.text, /^Stopping/);
  const second = await working("hang two");
  const byId = await typed(`/stop ${second.id.slice(0, 8)}`);
  assert.match(byId.body.text, /^Stopping/, byId.text);
  await finished();
  assert.equal(app.store.run(first.id).status, "cancelled");
  assert.equal(app.store.run(second.id).status, "cancelled");
});

/* S4 */
test("conversation check: POST /api/commands/run takes the person's own conversation and refuses the owner's like a missing one", async (t) => {
  const { app, asOwner, asSam, typed } = await served(t);
  asOwner();
  const owners = await app.runtime.run({ prompt: "owner's words" });
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "sam's words", onTextDelta: () => undefined });
  const theirs = await typed("/export", owners.sessionId), missing = await typed("/export", randomUUID());
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs.body, { error: "Conversation not found" });
  assert.deepEqual([missing.status, missing.body], [theirs.status, theirs.body], "the owner's reads exactly like one that is not there");
  const own = await typed("/export", sams.sessionId);
  assert.equal(own.status, 200, own.text);
  assert.match(own.body.client.text, /sam's words/, "Sam saves his own conversation");
  assert.doesNotMatch(own.body.client.text, /owner's words/);
  asOwner();
  const ownerOwn = await typed("/export", owners.sessionId);
  assert.match(ownerOwn.body.client?.text ?? "", /owner's words/, "control: the owner saves theirs");
});

/* S5, S6, S25 */
test("only their commands: a household person at the window is refused the rest, and the owner's saved commands are none", async (t) => {
  const { app, call, asOwner, asSam, typed } = await served(t);
  savePromptLibrarySettings(app.store, app.runtime.owner, { mode: "on" });
  savePrompt(app.store, app.runtime.owner, { title: "Owner weekly", body: "owner secret plan", command: "zqweekly" }, () => false);
  asOwner();
  assert.equal((await typed("/zqweekly")).body.handled, true, "control: the owner's saved command works for the owner");
  assert.equal((await typed("/skills")).body.refused, undefined, "control: the owner may list skills");
  asSam();
  for (const line of ["/skills", "/prompts", "/btw what is this", "/compact", "/goal be done", "/help what is lockdown",
    "/suggestions", "/installs", "/account", "/health", "/preset", "/lockdown on", "/trunk", "/bg tidy up", "/loop"]) {
    const answer = await typed(line);
    assert.equal(answer.status, 200, `${line}: ${answer.text}`);
    assert.deepEqual({ refused: answer.body.refused, text: answer.body.text }, { refused: true, text: refusal }, `${line} is refused`);
  }
  assert.deepEqual((await typed("/zqweekly")).body, { handled: false }, "the owner's saved command is no command for Sam");
  for (const line of ["/help", "/version", "/lockdown", "/new"]) {
    const answer = await typed(line);
    assert.equal(answer.body.handled, true, line);
    assert.equal(answer.body.refused, undefined, `${line} is Sam's to send`);
  }
  const listed = (await call("GET", "/api/commands?surface=window")).body.commands.map((row) => row.name);
  assert.equal(listed.includes("zqweekly"), false, "the owner's saved command is not listed for Sam");
  asOwner();
  assert.ok((await call("GET", "/api/commands?surface=window")).body.commands.some((row) => row.name === "zqweekly"), "control: listed for the owner");
});

/* S7 */
test("terminal acts as the owner: the same command from the terminal is not narrowed while the window is on Sam", async (t) => {
  const { app, asSam, working } = await served(t);
  const owners = await working();
  app.store.save("memory", app.runtime.owner, "owner-fact", { text: "owner fact zq", source: "owner" });
  asSam();
  const host = commandHost(app.runtime, app);
  const memory = await executeCommand(host, { surface: "terminal", line: "/memory", access: "full" });
  assert.match(memory.text, /owner fact zq/, "the terminal reads the owner's facts");
  const stop = await executeCommand(host, { surface: "terminal", line: `/stop ${owners.id.slice(0, 8)}`, access: "full" });
  assert.match(stop.text, /^Stopping/, "the terminal stops the owner's task");
  const skills = await executeCommand(host, { surface: "terminal", line: "/skills", access: "full" });
  assert.equal(skills.refused, undefined, "the terminal is not held to the window's list");
});

/* S8, S9, S10, S11 */
test("narrowed commands: /sessions, /status, /usage, /memory and /whoami answer for the household person only", async (t) => {
  const { app, asOwner, asSam, typed, working } = await served(t);
  asOwner();
  const ownerDone = await app.runtime.run({ prompt: "owner's finished" });
  const owners = await working();
  app.store.save("memory", app.runtime.owner, "owner-fact", { text: "owner fact zq", source: "owner" });
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "sam's finished", onTextDelta: () => undefined });
  app.store.save("memory", app.store.profiles.scope(), "sam-fact", { text: "sam fact zq", source: "owner" });
  const samsWorking = await working("hang sam");
  assert.equal((await typed(`/sessions ${ownerDone.sessionId.slice(0, 8)}`)).body.text, "No conversation has that id.");
  assert.deepEqual((await typed(`/sessions ${sams.sessionId.slice(0, 8)}`)).body.client, { do: "open-session", id: sams.sessionId }, "his own opens");
  const status = (await typed("/status")).body.text;
  assert.ok(status.includes(samsWorking.id.slice(0, 8)), status);
  assert.equal(status.includes(owners.id.slice(0, 8)), false, "the owner's working task is not listed");
  assert.doesNotMatch(status, /When to check with you/, "the owner's approval setting is left out");
  const usage = (await typed("/usage", sams.sessionId)).body.text;
  assert.match(usage, /This conversation/);
  assert.doesNotMatch(usage, /This month/, "the owner's month is left out");
  const memory = (await typed("/memory")).body.text;
  assert.match(memory, /sam fact zq/);
  assert.doesNotMatch(memory, /owner fact zq/, "the owner's facts are left out");
  assert.match((await typed("/whoami")).body.text, /your own profile/);
  asOwner();
  const ownerStatus = (await typed("/status")).body.text;
  assert.ok(ownerStatus.includes(owners.id.slice(0, 8)) && /When to check with you/.test(ownerStatus), "control: the owner's status is whole");
  assert.match((await typed("/usage")).body.text, /This month/, "control: the owner sees the month");
  assert.match((await typed("/memory")).body.text, /owner fact zq/, "control: the owner's facts");
  assert.deepEqual((await typed(`/sessions ${ownerDone.sessionId.slice(0, 8)}`)).body.client, { do: "open-session", id: ownerDone.sessionId });
});

/* S12, S13 */
test("policy and categories: a household person is sent none of the owner's approval rules", async (t) => {
  const { call, asOwner, asSam } = await served(t);
  asOwner();
  const owner = (await call("GET", "/api/policy")).body, categories = (await call("GET", "/api/approvals/categories")).body.categories;
  assert.ok(owner.policy && Array.isArray(owner.policy.rules), "control: the owner reads the policy");
  assert.ok(categories.length > 0, "control: the owner reads the categories");
  asSam();
  const theirs = (await call("GET", "/api/policy")).body;
  assert.equal(theirs.policy, null, "no policy for Sam");
  assert.ok(Array.isArray(theirs.presets) && Array.isArray(theirs.waiting), "the presets and his own waiting list stay");
  assert.deepEqual((await call("GET", "/api/approvals/categories")).body.categories, [], "no categories for Sam");
});

/* S14, S15 */
test("audit: a household person reads the record of their own tasks only, in the list and the spreadsheet", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  asOwner();
  const owners = await app.runtime.run({ prompt: "owner's task" });
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "sam's task", onTextDelta: () => undefined }), samScope = app.store.profiles.scope();
  const owner = app.runtime.owner;
  audit(app.store, owner, { action: "secret.used", actor: owner, subject: "zq-owner-entry", reason: "owner", outcome: "used", runId: owners.id });
  audit(app.store, owner, { action: "secret.used", actor: owner, subject: "zq-sam-entry", reason: "sam", outcome: "used", runId: sams.id });
  const list = (await call("GET", "/api/audit")).body;
  assert.deepEqual(list.entries.map((entry) => entry.subject), ["zq-sam-entry"]);
  assert.equal(list.counts.find((row) => row.action === "secret.used").count, 1, "counted from his own entries");
  const csv = (await call("GET", "/api/audit/export.csv")).text;
  assert.match(csv, /zq-sam-entry/);
  assert.doesNotMatch(csv, /zq-owner-entry/, "the spreadsheet leaves the owner's out");
  asOwner();
  const whole = (await call("GET", "/api/audit")).body.entries.map((entry) => entry.subject);
  assert.ok(whole.includes("zq-owner-entry") && whole.includes("zq-sam-entry"), "control: the owner reads both");
  assert.match((await call("GET", "/api/audit/export.csv")).text, /zq-owner-entry/);
  const exported = app.store.audit.list(owner, { action: "data.exported" }).map((entry) => entry.actor);
  assert.deepEqual(exported, [owner, samScope], "each spreadsheet names who saved it: Sam his, the owner theirs");
});

/* S16, S17 */
test("usage and prompts: a household person counts their own conversations and is sent none of the owner's prompts", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  savePromptLibrarySettings(app.store, app.runtime.owner, { mode: "on" });
  savePrompt(app.store, app.runtime.owner, { title: "Owner weekly", body: "owner secret plan", command: "zqweekly" }, () => false);
  asOwner();
  const owners = await app.runtime.run({ prompt: "owner's task" });
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "sam's task", onTextDelta: () => undefined });
  const conversations = (body) => body.data.flatMap((day) => day.byConversation.map((row) => row.sessionId));
  const theirs = (await call("GET", "/api/usage?range=7d&by=day")).body;
  assert.deepEqual(conversations(theirs), [sams.sessionId], "only his conversation is counted");
  assert.equal(theirs.stats, null);
  // Q261: reading fails closed for a household person, and the window never asks for the spreadsheet, so it is refused.
  assert.equal((await call("GET", "/api/usage/export.csv?range=7d")).status, 400, "the spreadsheet is not in householdReads");
  const prompts = (await call("GET", "/api/prompts")).body;
  assert.deepEqual(prompts.prompts, [], "none of the owner's prompts");
  assert.equal((await call("GET", "/api/prompts/export")).status, 400, "the owner's export is refused");
  asOwner();
  const whole = conversations((await call("GET", "/api/usage?range=7d&by=day")).body);
  assert.ok(whole.includes(owners.sessionId), "control: the owner counts theirs");
  assert.equal((await call("GET", "/api/prompts")).body.prompts.length, 1, "control: the owner's prompts");
});

/* S18, S19, S20, S21, S26 */
test("task details: /inspect, /steps, /trajectory and the Markdown export find only their own; replay and pairing are the owner's", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  asOwner();
  const owners = await app.runtime.run({ prompt: "owner's task" });
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "sam's task", onTextDelta: () => undefined });
  for (const part of ["inspect", "steps"]) {
    assert.equal((await call("GET", `/api/runs/${owners.id}/${part}`)).status, 404, `${part} of the owner's task`);
    assert.equal((await call("GET", `/api/runs/${sams.id}/${part}`)).status, 200, `${part} of his own task`);
  }
  // Q261: reading fails closed for a household person, and the window never asks for a trajectory, so it is refused.
  for (const id of [owners.id, sams.id]) assert.equal((await call("GET", `/api/runs/${id}/trajectory`)).body.error, refusal, "trajectory");
  assert.equal((await call("GET", `/api/sessions/${owners.sessionId}/export?format=markdown`)).status, 404);
  assert.match((await call("GET", `/api/sessions/${sams.sessionId}/export?format=markdown`)).text, /sam's task/);
  const replay = await call("POST", `/api/runs/${sams.id}/replay`, {});
  assert.equal(replay.status, 400, replay.text);
  assert.match(replay.body.error, /belongs to the owner/, "doing even his own task again, as the owner, is refused");
  const beforeRuns = app.store.runs(app.runtime.owner).length;
  assert.equal((await call("POST", `/api/runs/${owners.id}/replay`, {})).status, 400);
  assert.equal(app.store.runs(app.runtime.owner).length, beforeRuns, "no task was started");
  const pairing = await call("GET", "/api/agents/pairing");
  assert.deepEqual([pairing.status, pairing.body.error], [400, refusal]);
  for (const path of ["/api/brief", "/api/research"]) {
    const read = await call("GET", path);
    assert.deepEqual([read.status, read.body.error], [400, refusal], `${path} is the owner's`);
  }
  asOwner();
  app.store.save("schedules", app.runtime.owner, "zq-due", { prompt: "owner's due errand", status: "pending", dueAt: new Date().toISOString() });
  assert.match((await call("GET", "/api/brief")).text, /owner's due errand/, "control: the owner's brief holds the owner's schedule");
  assert.equal((await call("GET", "/api/research")).status, 200, "control: the owner's research");
  for (const part of ["inspect", "steps", "trajectory"]) assert.equal((await call("GET", `/api/runs/${owners.id}/${part}`)).status, 200, `control: ${part}`);
  assert.match((await call("GET", `/api/sessions/${owners.sessionId}/export?format=markdown`)).text, /owner's task/);
  assert.equal((await call("GET", "/api/agents/pairing")).status, 200, "control: the owner's pairing link");
});

/* S22, S23 */
test("branch run presets: refused under Lockdown, and --save-preset needs --confirm to make Branch less careful", async (t) => {
  const { app } = await served(t);
  const { store } = app, owner = app.runtime.owner, preset = () => readPolicy(store, owner).preset;
  savePolicy(store, owner, { preset: "ask-before-changes" });
  assert.throws(() => usePreset(store, owner, "off", true, { tools: app.registry }), /less careful.*Add --confirm after --save-preset off to go ahead\./s);
  assert.equal(preset(), "ask-before-changes", "an unconfirmed loosening changes nothing");
  usePreset(store, owner, "read-only", true, { tools: app.registry });
  assert.equal(preset(), "read-only", "control: a stricter preset needs no yes");
  usePreset(store, owner, "off", true, { confirm: true, tools: app.registry });
  assert.equal(preset(), "off", "control: with --confirm it loosens");
  savePolicy(store, owner, { preset: "ask-before-changes" });
  setLockdown(store, owner, { on: true });
  const locked = preset();
  assert.throws(() => usePreset(store, owner, "off", false), /Lockdown is on/, "--preset for one task is refused under Lockdown");
  assert.throws(() => usePreset(store, owner, "read-only", true, { confirm: true }), /Lockdown is on/, "--save-preset is refused under Lockdown");
  assert.equal(preset(), locked, "Lockdown's policy is left as it was");
  setLockdown(store, owner, { on: false });
  assert.equal(parseRunArgs(["--save-preset", "off", "--confirm", "go"]).confirm, true);
  assert.throws(() => parseRunArgs(["--confirm", "go"]), /--confirm goes with --save-preset/);
});

/* S24 */
test("branch permissions says how its own yes is typed", async (t) => {
  const { app } = await served(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const lines = [], io = { interactive: false, env: {}, json: false, write: (line) => lines.push(line) };
  await assert.rejects(runTerminalCommand(app, "permissions", ["off"], io), /Run branch permissions off confirm to go ahead\./);
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "ask-before-changes");
  await runTerminalCommand(app, "permissions", ["off", "confirm"], io);
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "off", "control: the words it gives work");
});
