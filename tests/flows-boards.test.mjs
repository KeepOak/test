/**
 * R17-H: flows and boards — going back to an earlier step of a flow (R17-069), checks with clean-up
 * and retries (R17-070), the shared board (R17-071), widgets the assistant builds (R17-072), the
 * waiting line you can change and typing while it works (R17-073), focus view (R17-074), and
 * requests for packages and tool servers answered only by the owner (R17-075). Every part ships off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { boardParts, boardTools } from "../dist/flows-boards/settings.js";
import { InstallRequests } from "../dist/flows-boards/install-requests.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { asPerson } from "../dist/people/context.js";

function controlled() {
  const waiting = [];
  const provider = { name: "scripted", fail: false, hold: false, async complete() {
    if (provider.hold) await new Promise((resolve) => waiting.push(resolve));
    if (provider.fail) throw new Error("the model is down");
    return { content: "Done.", toolCalls: [] };
  } };
  return { provider, release: () => { provider.hold = false; for (const go of waiting.splice(0)) go(); } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-flows-boards-"));
  const { provider, release } = controlled();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.close(); await discardTemp(root); });
  const on = (part) => app.flowsBoards.setMode(part, { mode: "on" });
  return { app, root, provider, release, on };
}
const wait = async (check, tries = 200) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting");
};
/** A run with no marks of its own is the owner's own work. */
const ownersRun = (app) => app.store.createRun(app.runtime.owner, "owner's own work").id;
const chatRun = (app) => {
  const id = app.store.createRun(app.runtime.owner, "from a chat").id;
  app.store.event(id, "channel.inbound", { channel: "telegram", chatId: "1", messageId: "1" });
  return id;
};
const callAs = (app, runId, name, args) => app.registry.execute(name, args, app.runtime.context({ runId }));

test("every part ships off: no tools, and each refuses in one sentence", async (t) => {
  const { app } = await fixture(t);
  for (const part of boardParts) assert.equal(app.flowsBoards.mode(part), "off", part);
  const names = new Set(app.registry.names());
  for (const tool of Object.values(boardTools).flat()) assert.equal(names.has(tool), false, `${tool} is hidden while off`);
  assert.throws(() => app.flowsBoards.kanban.view(), /switched off/);
  await assert.rejects(app.flowsBoards.installs.request({ kind: "package", ecosystem: "npm", name: "left-pad", why: "x" }, "assistant", "the assistant"), /switched off/);
  app.flowsBoards.setMode("kanban", { mode: "when-needed" });
  assert.ok(app.registry.names().includes("board.cards"), "the tools come back once the part is not off");
});

/* ---------- R17-069 ---------- */

function shouter(app) {
  app.registry.register({ name: "tests.shout", permission: "workflows.read", description: "Says the item back in capitals.",
    parameters: z.object({ item: z.unknown().optional() }).passthrough(), execute: async (value) => String(value.item ?? "").toUpperCase() });
}
const twoTools = {
  name: "Shout twice", input: { topic: "text" }, state: { first: "text", second: "text" }, entry: "a",
  nodes: [
    { id: "a", name: "First shout", kind: "tool", tool: "tests.shout", args: { item: "{topic}" }, input: { topic: "text" }, output: { first: "text" } },
    { id: "b", name: "Second shout", kind: "tool", tool: "tests.shout", args: { item: "{first} again" }, input: { first: "text" }, output: { second: "text" } },
  ],
  edges: [{ from: "a", to: "b" }],
};

test("R17-069 a flow can go back to an earlier step, change a value, and run a copy; the original stays", async (t) => {
  const { app, on } = await fixture(t);
  shouter(app);
  const saved = app.flows.saveGraph(twoTools);
  const quiet = await app.flows.settled(app.flows.startGraph(saved.id, { topic: "ignored" }).runId);
  on("time-travel");
  assert.equal(app.flowsBoards.timeTravel.steps(quiet.runId).steps.length, 0, "nothing was kept while the part was off");

  const first = await app.flows.settled(app.flows.startGraph(saved.id, { topic: "oak" }).runId);
  assert.equal(first.state.second, "OAK AGAIN");
  const { steps } = app.flowsBoards.timeTravel.steps(first.runId);
  assert.deepEqual(steps.map((s) => s.seq), [0, 1, 2]);
  assert.equal(steps[1].state.first, "OAK");
  assert.equal(steps[1].nextNode, "b");

  assert.throws(() => app.flowsBoards.timeTravel.fork(first.runId, { seq: 1, changes: { nope: "x" } }), /do not fit this flow/);
  assert.throws(() => app.flowsBoards.timeTravel.fork(first.runId, { seq: 1, changes: { first: 5 } }), /do not fit this flow/);
  assert.throws(() => app.flowsBoards.timeTravel.fork(first.runId, { seq: 2 }), /last step/);

  const copy = app.flowsBoards.timeTravel.fork(first.runId, { seq: 1, changes: { first: "birch" } });
  const done = await app.flowsBoards.timeTravel.settled(copy.runId);
  assert.equal(done.status, "completed");
  assert.equal(done.state.second, "BIRCH AGAIN");
  assert.deepEqual(done.nodes.map((n) => n.nodeId), ["a", "b"], "the copy carries the steps before it, then its own");
  assert.equal(app.flows.runState(first.runId).state.second, "OAK AGAIN", "the run it came from is unchanged");
  const record = app.flowsBoards.timeTravel.steps(copy.runId);
  assert.deepEqual(record.forkedFrom, { runId: first.runId, seq: 1, changed: ["first"] });
  assert.ok(app.store.events(copy.runId).some((e) => e.kind === "flow.forked"), "the copy's own record says where it came from");
  assert.ok(app.flowsBoards.timeTravel.runs().some((r) => r.runId === copy.runId));
});

/* ---------- R17-070 ---------- */

async function verifiedProcedure(app) {
  const counts = { work: 0, probe: 0, tidy: 0 };
  const tool = (name, answer) => app.registry.register({ name, permission: "workflows.read", description: `test ${name}`,
    parameters: z.object({}).passthrough(), execute: async () => answer() });
  tool("tests.work", () => { counts.work++; return { ok: true }; });
  tool("tests.probe", () => { counts.probe++; return counts.probe >= 3 ? "ready" : "not yet"; });
  tool("tests.tidy", () => { counts.tidy++; return "tidied"; });
  const context = app.runtime.context();
  const proposed = await app.registry.execute("procedures.propose", { name: "Work once", preconditions: [], steps: [{ tool: "tests.work", args: {}, expected: { ok: true } }] }, context);
  await app.registry.execute("procedures.verify", { id: proposed.id }, context);
  counts.work = 0;
  return { id: proposed.id, counts };
}

test("R17-070 checks really run, clean-up runs after each failed try, and the count of tries holds", async (t) => {
  const { app, on } = await fixture(t);
  const { id, counts } = await verifiedProcedure(app);
  on("recipe-checks");
  assert.throws(() => app.flowsBoards.recipes.save(id, { checks: [{ tool: "procedures.replay", args: {} }] }), /cannot use procedures.replay/);
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.probe", args: {}, contains: "ready" }], cleanup: [{ tool: "tests.tidy", args: {} }], retries: 1 });
  const short = await app.flowsBoards.runChecked(id, {});
  assert.equal(short.status, "failed");
  assert.equal(short.attempts, 2);
  assert.equal(counts.tidy, 2, "clean-up ran after each failed try");
  assert.match(short.reasons[0], /did not say "ready"/);
  assert.equal(app.store.run(short.runId).status, "failed");

  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.probe", args: {}, contains: "ready" }], cleanup: [{ tool: "tests.tidy", args: {} }], retries: 3 });
  const long = await app.flowsBoards.runChecked(id, {});
  assert.equal(long.status, "passed");
  assert.equal(long.attempts, 1, "the third probe answers ready on the next first try");
  assert.equal(counts.work, 3, "the procedure itself ran once per try");
});

test("R17-070 the assistant's tool stays inside what its task may do, and a refusal is never retried", async (t) => {
  const { app, on } = await fixture(t);
  const { id, counts } = await verifiedProcedure(app);
  on("recipe-checks");
  app.registry.register({ name: "tests.secret", permission: "secrets.manage", description: "test", parameters: z.object({}).passthrough(), execute: async () => "ready" });
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.secret", args: {} }], cleanup: [{ tool: "tests.tidy", args: {} }], retries: 3 });
  const context = { ...app.runtime.context({ runId: ownersRun(app) }), permissions: new Set(["procedures.use", "workflows.read"]) };
  await assert.rejects(app.registry.execute("procedures.replay_checked", { id }, context), /permission this task does not have|refused/i);
  assert.equal(counts.work, 1, "no second try after a refusal");
  assert.equal(counts.tidy, 0);
});

/* ---------- R17-071 ---------- */

test("R17-071 the shared board: lanes, hand-offs, what the assistant may not do, and the circuit breaker", async (t) => {
  const { app, provider, on } = await fixture(t);
  on("kanban");
  app.flowsBoards.kanban.saveSettings({ stopAfter: 2 });
  const mine = ownersRun(app);
  const card = await callAs(app, mine, "board.card_add", { title: "Water\nthe oak", notes: "twice a week" });
  assert.equal(card.lane, "todo");
  assert.equal(card.title, "Water the oak", "a title is one line");
  await assert.rejects(callAs(app, chatRun(app), "board.card_add", { title: "planted" }), /Only the owner's own work/);
  await assert.rejects(callAs(app, mine, "board.card_move", { id: card.id, lane: "done" }), /owner's/);
  const moved = await callAs(app, mine, "board.card_move", { id: card.id, lane: "doing" });
  assert.equal(moved.lane, "doing");
  const handed = await callAs(app, mine, "board.card_handoff", { id: card.id, to: "gardener", note: "you know the soil" });
  assert.equal(handed.assignee, "gardener");
  assert.equal(handed.lane, "todo");
  assert.match(handed.history.at(-1).what, /you know the soil/);

  app.asks.setMode("project-board", { mode: "on" });
  const view = app.flowsBoards.kanban.view();
  assert.ok(view.items && Array.isArray(view.items.flows), "the bucket-23 project board is laid under the lanes");
  assert.equal(view.lanes.todo[0].id, card.id);

  provider.fail = true;
  app.flowsBoards.kanban.work(card.id);
  assert.equal((await app.flowsBoards.kanban.settled(card.id)).lane, "todo");
  app.flowsBoards.kanban.work(card.id);
  const stuck = await app.flowsBoards.kanban.settled(card.id);
  assert.equal(stuck.lane, "blocked");
  assert.equal(stuck.stuck, true);
  assert.throws(() => app.flowsBoards.kanban.work(card.id), /stopped after failing/);
  await assert.rejects(callAs(app, mine, "board.card_move", { id: card.id, lane: "todo" }), /owner's/);
  provider.fail = false;
  app.flowsBoards.kanban.reset(card.id);
  app.flowsBoards.kanban.work(card.id);
  const finished = await app.flowsBoards.kanban.settled(card.id);
  assert.equal(finished.lane, "review");
  assert.equal(finished.failures, 0);
  assert.ok(finished.runId, "the card knows its task");
});

/* ---------- R17-072 ---------- */

test("R17-072 a widget is a question first, only a look-only tool, and then a sealed live page", async (t) => {
  const { app, root, on } = await fixture(t);
  on("widgets");
  app.registry.register({ name: "tests.weather", permission: "web.read", description: "test", parameters: z.object({}).passthrough(), execute: async () => "sunny <b>today</b>" });
  const mine = ownersRun(app);
  await assert.rejects(callAs(app, mine, "widgets.propose", { title: "Files", tool: "files.write", why: "x" }), /only use a tool that looks/);
  await assert.rejects(callAs(app, chatRun(app), "widgets.propose", { title: "Weather", tool: "tests.weather", why: "x" }), /owner's own conversation/);
  const asked = await callAs(app, mine, "widgets.propose", { title: "Weather", tool: "tests.weather", everySeconds: 600, why: "you ask every morning" });
  assert.equal(asked.status, "waiting");
  assert.equal(app.flowsBoards.waitingForOwner().widgets, 1);
  // The owner's rule (ships on, 2026-09-26): live pages ship "when needed", so the refusal is tested switched off.
  app.asks.setMode("live-surfaces", { mode: "off" });
  await assert.rejects(app.flowsBoards.widgets.decide(asked.id, true), /Switch on/);
  app.asks.setMode("live-surfaces", { mode: "on" });
  await app.flowsBoards.widgets.decide(asked.id, true);
  const [widget] = app.flowsBoards.widgets.list();
  assert.equal(widget.title, "Weather");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const page = await fetch(server.url + widget.frame);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /sunny &lt;b&gt;today/);

  const again = await callAs(app, mine, "widgets.propose", { title: "Clock", tool: "tests.weather", args: { a: 1 }, why: "x" });
  await app.flowsBoards.widgets.decide(again.id, false);
  assert.equal((await callAs(app, mine, "widgets.propose", { title: "Clock again", tool: "tests.weather", args: { a: 1 }, why: "x" })).status, "already asked", "a no is not asked again");
  assert.deepEqual(app.flowsBoards.widgets.remove(widget.id), { removed: true });
  assert.equal(app.asks.surfaces.list().length, 0);
});

/* ---------- R17-073 ---------- */

test("R17-073 waiting messages can be read, reworded, moved and taken out; steer and interrupt work while busy", async (t) => {
  const { app, provider, release, on } = await fixture(t);
  on("waiting-line");
  const first = await app.runtime.run({ prompt: "start", onTextDelta: () => undefined });
  provider.hold = true;
  const working = app.runtime.run({ prompt: "a long job", sessionId: first.sessionId, onTextDelta: () => undefined });
  const session = first.sessionId;
  await wait(() => app.store.runs(app.runtime.owner).some((r) => r.sessionId === session && r.status === "running"));
  const lines = app.flowsBoards.waiting;
  lines.send(session, "one", "queue");
  lines.send(session, "two", "queue");
  let items = lines.followUps(session);
  assert.deepEqual(items.map((i) => i.prompt), ["one", "two"]);
  items = lines.moveFollowUp(session, items[1].id, { direction: "up" });
  assert.deepEqual(items.map((i) => i.prompt), ["two", "one"]);
  items = lines.editFollowUp(session, items[1].id, { prompt: "one, reworded" });
  items = lines.removeFollowUp(session, items[0].id);
  assert.deepEqual(items.map((i) => i.prompt), ["one, reworded"]);
  assert.deepEqual(lines.everywhere().map((e) => e.sessionId), [session]);

  const steered = lines.send(session, "use the blue pot", "steer");
  assert.equal(steered.mode, "steer");
  assert.ok(app.store.events((await wait(() => true), app.store.runs(app.runtime.owner).find((r) => r.status === "running").id)).some((e) => e.kind === "run.steered"));
  assert.equal(lines.followUps(session).length, 1, "a steer does not queue");

  const stopped = lines.send(session, "do this instead", "interrupt");
  assert.equal(stopped.mode, "interrupt");
  release();
  const ended = await working;
  assert.equal(ended.status, "cancelled");
  await wait(() => app.store.runs(app.runtime.owner).filter((r) => r.sessionId === session && r.status === "completed").length >= 3);
  const prompts = app.store.runs(app.runtime.owner).filter((r) => r.sessionId === session).map((r) => r.prompt);
  assert.ok(prompts.indexOf("do this instead") > prompts.indexOf("one, reworded"), "the interrupting message went first (the list is newest first)");
  assert.equal(lines.saveBusyMode({ mode: "steer" }), "steer");
  assert.throws(() => lines.saveBusyMode({ mode: "shout" }));
});

test("R17-073 the app's waiting line can be reworded and reordered without jumping the owner-first rule", async (t) => {
  const { app, provider, release, on } = await fixture(t);
  on("waiting-line");
  app.runQueue.configure(app.runtime.owner, { atOnce: 1 });
  provider.hold = true;
  const owner = app.runtime.owner;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  const busy = app.runQueue.submit(owner, { prompt: "busy" });
  await pause();
  const a = app.runQueue.submit(owner, { prompt: "alpha" });
  await pause();
  const b = app.runQueue.submit(owner, { prompt: "beta" });
  await pause();
  const auto = app.runQueue.submit(owner, { prompt: "scheduled", source: "schedule" });
  const lines = app.flowsBoards.waiting;
  assert.deepEqual(lines.tasks().map((x) => x.prompt), ["alpha", "beta", "scheduled"]);
  lines.moveQueued(b.id, { direction: "first" });
  lines.editQueued(a.id, { prompt: "alpha, reworded" });
  assert.deepEqual(lines.tasks().map((x) => x.prompt), ["beta", "alpha, reworded", "scheduled"]);
  lines.moveQueued(auto.id, { direction: "first" });
  assert.equal(lines.tasks().at(-1).prompt, "scheduled", "automatic work stays behind the owner's");
  assert.deepEqual(lines.removeQueued(a.id), { cancelled: true });
  assert.deepEqual(lines.tasks().map((x) => x.prompt), ["beta", "scheduled"]);
  // Nothing is left to start once the app closes.
  lines.removeQueued(b.id);
  lines.removeQueued(auto.id);
  release();
  await wait(() => app.runQueue.entry(owner, busy.id)?.status !== "running");
});

/* ---------- R17-074 and the commands ---------- */

test("R17-074 /focus answers with the page action; /queue and /busy follow their part's switch", async (t) => {
  const { app } = await fixture(t);
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const host = commandHost(app.runtime, app);
  const off = await executeCommand(host, { surface: "window", line: "/focus on", access: "full" });
  assert.match(off.text, /switched off/);
  assert.equal(off.client, undefined);
  app.flowsBoards.setMode("focus", { mode: "on" });
  const on = await executeCommand(host, { surface: "window", line: "/focus on", access: "full" });
  assert.deepEqual(on.client, { do: "focus", on: true });
  assert.equal(await executeCommand(host, { surface: "chat", line: "/focus", access: "full" }), null, "focus is a window thing");
  assert.match((await executeCommand(host, { surface: "window", line: "/busy steer", access: "full" })).text, /switched off/);
  app.flowsBoards.setMode("waiting-line", { mode: "on" });
  assert.match((await executeCommand(host, { surface: "window", line: "/busy steer", access: "full" })).text, /handed to the working task/);
  assert.match((await executeCommand(host, { surface: "window", line: "/queue", access: "full" })).text, /Start a conversation/);
});

/* ---------- R17-075 ---------- */

function osv(listed) {
  const asked = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.package.name);
    if (body.package.name === "offline-pkg") throw new Error("no network");
    const vulns = listed.includes(body.package.name) ? [{ id: "MAL-2026-1", summary: "steals keys" }] : [];
    return new Response(JSON.stringify({ vulns }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { asked, fetcher };
}

test("R17-075 anyone can ask, the malware list is checked, only the owner answers, and nothing installs", async (t) => {
  const { app, on } = await fixture(t);
  on("install-requests");
  const { asked, fetcher } = osv(["evil-pkg"]);
  const installs = new InstallRequests({ store: app.store, owner: app.runtime.owner, fetch: () => fetcher, endpoint: "https://osv.test/v1/query" });
  const bad = await installs.request({ kind: "package", ecosystem: "npm", name: "evil-pkg", why: "it helps" }, "chat", "a chat app");
  assert.equal(bad.status, "refused");
  assert.match(bad.check.note, /MAL-2026-1/);
  const good = await installs.request({ kind: "package", ecosystem: "PyPI", name: "requests", version: "2.32.3", why: "fetch pages" }, "assistant", "the assistant");
  assert.equal(good.status, "waiting");
  assert.equal(good.check.state, "clean");
  const same = await installs.request({ kind: "package", ecosystem: "PyPI", name: "requests", version: "2.32.3", why: "again" }, "assistant", "the assistant");
  assert.equal(same.id, good.id, "the same request is not asked twice");
  const offline = await installs.request({ kind: "package", ecosystem: "npm", name: "offline-pkg", why: "x" }, "assistant", "the assistant");
  assert.equal(offline.check.state, "unchecked");
  await assert.rejects(installs.answer(offline.id, true), /could not be asked/);
  assert.equal((await installs.answer(offline.id, true, { despiteUnchecked: true })).status, "approved");
  const server = await installs.request({ kind: "mcp", name: "weather", server: { transport: "stdio", command: "npx", args: ["-y", "weather-mcp@1.0.0"] }, why: "forecasts" }, "assistant", "the assistant");
  assert.ok(asked.includes("weather-mcp"), "a server fetched from npm is looked up too");
  const approved = await installs.answer(good.id, true);
  assert.equal(approved.nextStep, 'python3 -m pip install "requests==2.32.3"');
  assert.equal((await installs.answer(server.id, false)).status, "declined");
  await assert.rejects(installs.answer(bad.id, true), /not waiting/);
});

test("R17-075 through the tool and /installs: a chat can ask, and never approve", async (t) => {
  const { app, on } = await fixture(t);
  on("install-requests");
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const host = commandHost(app.runtime, app);
  const fromChat = await callAs(app, chatRun(app), "install.request",
    { kind: "mcp", name: "notes", server: { transport: "http", url: "https://mcp.example.com/mcp" }, why: "notes" });
  assert.equal(fromChat.by, "chat");
  assert.equal(fromChat.check.state, "nothing-to-check");
  const listed = await executeCommand(host, { surface: "chat", line: "/installs", access: "full" });
  assert.match(listed.text, /tool server notes — waiting/);
  const chatYes = await executeCommand(host, { surface: "chat", line: "/installs approve 1", access: "full" });
  assert.match(chatYes.text, /Only the owner can answer/);
  const keyYes = await executeCommand(host, { surface: "window", line: "/installs approve 1", access: "run" });
  assert.match(keyYes.text, /Only the owner can answer/);
  const personYes = await asPerson({ profileId: "kid", keyId: "k1" }, () => executeCommand(host, { surface: "window", line: "/installs approve 1", access: "full" }));
  assert.doesNotMatch(personYes.text, /approved/);
  assert.equal(app.flowsBoards.installs.waiting().length, 1, "still waiting after every refusal");
  const ownerYes = await executeCommand(host, { surface: "window", line: "/installs approve 1", access: "full" });
  assert.match(ownerYes.text, /approved/);
  assert.match(ownerYes.text, /Customize › Connections/);
  const lookKey = await executeCommand(host, { surface: "window", line: "/installs request npm left-pad@1.3.0 pad strings", access: "read" });
  assert.equal(lookKey.refused, true, "a look-only key cannot even ask");
});

test("the owner's routes: switches, the board, and a short-lived key refused every change", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (path, body, token = server.token) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const overview = await (await call("/api/flows-boards")).json();
  assert.equal(overview.modes.kanban, "off");
  assert.equal((await call("/api/flows-boards/board")).status, 409);
  assert.equal((await call("/api/flows-boards/switch", { part: "kanban", mode: "on" })).status, 200);
  const added = await (await call("/api/flows-boards/board/cards", { title: "Rake leaves" })).json();
  assert.equal(added.card.lane, "todo");
  const moved = await call(`/api/flows-boards/board/cards/${added.card.id}/move`, { lane: "done" });
  assert.equal((await moved.json()).card.lane, "done", "the owner may finish a card");
  const token = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("/api/flows-boards/switch", { part: "kanban", mode: "off" }, token)).status, 401);
  assert.equal((await call("/api/flows-boards/board", undefined, token)).status, 200, "a key may look");
});
