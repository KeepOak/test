/**
 * Orchard (src/orchard): Branch's task board for several agents, and Canopy (src/canopy.ts), its live overview.
 * Node only, through the engine and its own routes. design/redesign/tools/mutate-orchard.mjs breaks each guard named
 * below in the built engine and shows a test here goes red:
 * - a Trunk's or a chat's card is never pulled until the owner says yes (planted);
 * - nothing is pulled while Lockdown is on, for a paused Trunk, past the board's "at once", or before the cards it waits
 *   for are picked;
 * - what it starts is the owner's own task, under the owner's approval rules as they are;
 * - a card's task that stops to ask keeps its card growing, shows that exact question on the card, and a yes by its
 *   fingerprint carries the same task on to ripe;
 * - only the owner's own work reaches the tools; a chat may look, post and comment with /orchard, never start work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { setLockdown } from "../dist/lockdown.js";
import { runOrigin } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

const allowedNote = /The call you asked about did not run/;
/** Answers "Done."; a card called "write <file>" writes that file (and again after a yes); `fail` fails; `hold` waits. */
function model() {
  const waiting = [];
  const provider = { name: "scripted", fail: false, hold: false, async complete(request) {
    if (provider.hold) await new Promise((resolve) => waiting.push(resolve));
    if (provider.fail) throw new Error("the model is down");
    const last = request.messages.at(-1), text = String(last?.content ?? "");
    const system = String(request.messages[0]?.content ?? "");
    const named = /^write (\S+)$/m.exec(request.messages.map((m) => String(m.content ?? "")).join("\n"));
    const write = { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named?.[1] ?? "x.txt", content: "hello" }) }] };
    if (named && last?.role === "user") return write;
    if (named && last?.role === "tool" && !/"ok":true/.test(text) && allowedNote.test(system)) return write;
    return { content: "Done.", toolCalls: [] };
  } };
  return { provider, release: () => { provider.hold = false; for (const go of waiting.splice(0)) go(); } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-orchard-"));
  const { provider, release } = model();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  let server = null;
  t.after(async () => { release(); await server?.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const orchard = app.flowsBoards.orchard;
  const owner = { kind: "owner" };
  const serve = async () => {
    server ??= await startServer(app, { dataDir: join(root, "data"), port: 0 });
    return async (path, body, token = server.token) => {
      const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
  };
  return { app, root, provider, release, orchard, owner, serve };
}
const until = async (check, what = "timed out") => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(what);
};
const lane = (orchard, id) => orchard.data.card(id).lane;
const ownersRun = (app) => app.store.createRun(app.runtime.owner, "owner's own work").id;
const callAs = (app, context, name, args) => app.registry.execute(name, args, context);

test("Orchard ships on, every tool says it only touches Orchard, and the old shared board's tools are gone", async (t) => {
  const { app } = await fixture(t);
  assert.equal(app.flowsBoards.mode("kanban"), "when-needed", "on, its tools waiting in the index until a task calls for them");
  for (const name of ["orchard.boards", "orchard.cards", "orchard.card_add", "orchard.card_comment", "orchard.card_block"]) {
    assert.ok(app.registry.names().includes(name), name);
    assert.equal(app.registry.reachOf(name), "local", `${name} reaches nothing outside this computer`);
    assert.equal(app.registry.declaresTarget(name).target, true, `${name} names what it touches`);
  }
  for (const gone of ["board.cards", "board.card_add", "board.card_move", "board.card_handoff"]) assert.ok(!app.registry.names().includes(gone), gone);
});

test("the owner's card is pulled, grows, and lands in ripe; the owner picks it. Its task is the owner's own", async (t) => {
  const { app, orchard, owner } = await fixture(t);
  const card = orchard.add({ title: "Rake the leaves" }, owner);
  assert.equal(card.planted, true, "the owner's own card is planted");
  await until(() => lane(orchard, card.id) === "ripe", "the card ripened");
  const pulled = orchard.data.card(card.id);
  assert.equal(runOrigin(app.store, pulled.runId).source, "owner", "the owner's own task, under the owner's rules as they are");
  assert.equal(app.store.events(pulled.runId).find((e) => e.kind === "orchard.card")?.data.how, "pulled", "its record says Orchard pulled it");
  assert.equal((await orchard.move(card.id, { lane: "picked" })).lane, "picked");

  const second = orchard.add({ title: "Sweep the path" }, owner);
  await until(() => lane(orchard, second.id) === "ripe");
  await orchard.move(second.id, { lane: "blocked" });
  const grown = await orchard.start(second.id);
  assert.equal(grown.lane, "growing");
  assert.equal(app.store.events(grown.runId).find((e) => e.kind === "orchard.card")?.data.how, "grow", "Grow is the owner's press");
  await until(() => lane(orchard, second.id) === "ripe");
});

test("a card a Trunk or a chat posts waits for the owner's yes; assigning it is that yes", async (t) => {
  const { app, orchard, owner } = await fixture(t);
  const ed = app.trunks.create({ name: "Ed" });
  const context = { ...app.runtime.context({ runId: ownersRun(app) }), trunk: ed.id };
  const { card } = await callAs(app, context, "orchard.card_add", { title: "Plant the bulbs", assignee: "@ed" });
  assert.equal(card.planted, false);
  assert.equal(card.postedBy, `trunk:${ed.id}`);
  orchard.grow();
  await orchard.settled();
  assert.equal(lane(orchard, card.id), "seed", "a Trunk's own card is never pulled by itself");
  const chat = orchard.add({ title: "From a chat" }, { kind: "chat" });
  orchard.grow();
  assert.equal(lane(orchard, chat.id), "seed", "nor a chat's");
  orchard.assign(card.id, { to: ed.id });
  await until(() => lane(orchard, card.id) === "ripe", "given to Ed by the owner, it grows");
  const turn = app.store.events(orchard.data.card(card.id).runId).find((event) => event.kind === "trunk.turn");
  assert.equal(turn?.data.trunkId, ed.id, "it ran as Ed");
});

test("a card waits for the cards before it; the grower keeps to the board's limit, one card per Trunk, and skips a paused Trunk", async (t) => {
  const { app, orchard, owner, provider, release } = await fixture(t);
  const first = orchard.add({ title: "Dig the bed" }, owner);
  const after = orchard.add({ title: "Sow the seeds", after: [first.id] }, owner);
  assert.throws(() => orchard.link(first.id, { after: after.id }), /wait on each other/, "no loops");
  await until(() => lane(orchard, first.id) === "ripe");
  assert.equal(lane(orchard, after.id), "seed", "waits while the card before it is only ripe");
  await assert.rejects(orchard.start(after.id), /waits for "Dig the bed"/);
  await orchard.move(first.id, { lane: "picked" });
  await until(() => lane(orchard, after.id) === "ripe", "pulled once the card before it is picked");

  provider.hold = true;
  const board = orchard.view().board;
  orchard.editBoard(board.id, { atOnce: 1 });
  const a = orchard.add({ title: "Weed row one" }, owner);
  const b = orchard.add({ title: "Weed row two" }, owner);
  await until(() => orchard.data.card(a.id).runId);
  assert.equal(lane(orchard, b.id), "seed", "one at once on this board");
  orchard.editBoard(board.id, { atOnce: 4 });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.pause.pause(ed.id, {});
  const c = orchard.add({ title: "Prune", assignee: ed.id }, owner);
  const d = orchard.add({ title: "Mulch", assignee: ed.id }, owner);
  orchard.grow();
  assert.equal(lane(orchard, c.id), "seed", "a paused Trunk is not given work");
  app.trunks.pause.resume(ed.id);
  orchard.grow();
  await until(() => orchard.data.card(c.id).runId);
  assert.equal(lane(orchard, d.id), "seed", "one card per Trunk at a time");
  release();
  await until(() => lane(orchard, d.id) === "ripe");
});

test("nothing is pulled while Lockdown is on", async (t) => {
  const { app, orchard, owner } = await fixture(t);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const card = orchard.add({ title: "Water the oak" }, owner);
  orchard.grow();
  await orchard.settled();
  assert.equal(lane(orchard, card.id), "seed");
  setLockdown(app.store, app.runtime.owner, { on: false });
  orchard.grow();
  await until(() => lane(orchard, card.id) === "ripe");
});

test("failing too often blocks a card until the owner resets it; the task itself can block its card", async (t) => {
  const { app, orchard, owner, provider } = await fixture(t);
  const board = orchard.addBoard({ name: "Yard" });
  orchard.editBoard(board.id, { stopAfter: 2 });
  provider.fail = true;
  const card = orchard.add({ title: "Fix the fence", board: board.id }, owner);
  await until(() => orchard.data.card(card.id).stuck, "blocked after two failures");
  assert.equal(lane(orchard, card.id), "blocked");
  assert.equal(orchard.data.card(card.id).failures, 2);
  await assert.rejects(orchard.start(card.id), /Reset it first/);
  provider.fail = false;
  orchard.reset(card.id);
  await until(() => lane(orchard, card.id) === "ripe");
  assert.equal(orchard.data.card(card.id).failures, 0);

  const other = orchard.add({ title: "Paint the shed", board: board.id }, owner);
  await until(() => orchard.data.card(other.id).runId);
  const runId = orchard.data.card(other.id).runId;
  // As if the card's own task said it cannot go on (the finished task no longer moves a card that left growing).
  app.store.sqlite.prepare("UPDATE orchard_cards SET lane='growing' WHERE id=?").run(other.id);
  const blocked = await callAs(app, app.runtime.context({ runId }), "orchard.card_block", { why: "no paint" });
  assert.equal(blocked.card.lane, "blocked");
  await assert.rejects(callAs(app, app.runtime.context({ runId: ownersRun(app) }), "orchard.card_block", { why: "x" }), /not working on an Orchard card/);
});

test("the approval path: a card's task that asks keeps its card growing, the card shows that exact question, and a yes by its fingerprint ripens it", async (t) => {
  const { app, root, orchard, owner, serve } = await fixture(t);
  const call = await serve();
  const card = orchard.add({ title: "write fence.txt" }, owner);
  await until(() => orchard.data.card(card.id).runId && app.store.run(orchard.data.card(card.id).runId)?.status === "needs_input", "it stopped to ask");
  await orchard.settled();
  assert.equal(lane(orchard, card.id), "growing", "a question is not a failure");
  assert.equal(orchard.data.card(card.id).failures, 0);
  const other = orchard.add({ title: "write gate.txt" }, owner);
  await until(() => orchard.data.card(other.id).runId && app.store.run(orchard.data.card(other.id).runId)?.status === "needs_input");

  const view = (await call("orchard")).body;
  const shown = view.lanes.growing.find((c) => c.id === card.id);
  assert.equal(shown.asks.length, 1, "the card shows its own question, and only its own");
  const [ask] = shown.asks;
  assert.match(ask.fingerprint, /^[a-f0-9]{32}$/);
  assert.equal(ask.runId, shown.runId);
  assert.ok(shown.live && Array.isArray(shown.live.steps), "and its live steps");
  const said = await call("policy/approve", { sessionId: ask.sessionId, decision: "allow", remember: "never", fingerprint: ask.fingerprint, carryOn: true });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  await until(() => lane(orchard, card.id) === "ripe", "the same task carried on and ripened the card");
  assert.ok(existsSync(join(root, "workspace", "fence.txt")));
  assert.equal(orchard.data.card(card.id).runId, shown.runId, "no second task");
  assert.equal(lane(orchard, other.id), "growing", "the other card still waits on its own question");

  // Stopped from Canopy (the task's own route): the card is blocked, not failed.
  const canopy = (await call("canopy")).body;
  const task = canopy.tasks.find((each) => each.card?.id === other.id);
  assert.ok(task && task.asks === 1, "Canopy shows the card's task and what it waits on");
  assert.equal((await call(`runs/${task.id}/cancel`, {})).status, 200);
  await until(() => lane(orchard, other.id) === "blocked");
  assert.equal(orchard.data.card(other.id).failures, 0);
});

test("who may reach it: a household person, a chat and a short-lived key never change Orchard; the owner's routes work", async (t) => {
  const { app, orchard, serve } = await fixture(t);
  const call = await serve();
  const made = await call("orchard/cards", { title: "Owner's errand" });
  assert.equal(made.status, 200);
  assert.equal(made.body.card.planted, true);
  const token = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("orchard/cards", { title: "from a key" }, token)).status, 401, "a key cannot post");
  assert.equal((await call(`orchard/cards/${made.body.card.id}/grow`, {}, token)).status, 401, "nor start work");
  assert.equal((await call("orchard", undefined, token)).status, 200, "a key may look");

  const chat = app.store.createRun(app.runtime.owner, "from a chat").id;
  app.store.event(chat, "channel.inbound", { channel: "telegram", chatId: "1", messageId: "1" });
  await assert.rejects(callAs(app, app.runtime.context({ runId: chat }), "orchard.card_add", { title: "x" }), /owner's own work/);
  await assert.rejects(callAs(app, app.runtime.context({ runId: chat }), "orchard.cards", {}), /owner's own work/);
  await assert.rejects(asPerson({ profileId: "kid", keyId: "k1" }, () => callAs(app, app.runtime.context({ runId: ownersRun(app) }), "orchard.cards", {})), /household/);

  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const host = commandHost(app.runtime, app);
  const say = async (line, surface = "chat", access = "run") => (await executeCommand(host, { surface, line, access })).text;
  assert.match(await say("/orchard add Feed the birds"), /waits for the owner's yes/);
  const posted = orchard.data.cards().find((c) => c.title === "Feed the birds");
  assert.equal(posted.planted, false);
  assert.equal(posted.postedBy, "chat");
  const numbered = ["seed", "growing", "ripe", "picked", "blocked"].flatMap((l) => orchard.view().lanes[l]);
  const at = numbered.findIndex((c) => c.id === posted.id) + 1;
  assert.ok(at > 0);
  assert.match(await say(`/orchard grow ${at}`), /Only the owner/, "a chat never starts work");
  assert.match(await say(`/orchard comment ${at} please hurry`), /Comment added/);
  assert.equal(orchard.data.comments(posted.id).at(-1).by, "chat");
  assert.match(await say(`/orchard grow ${at}`, "window", "full"), /Growing/, "the owner may");
  await until(() => lane(orchard, posted.id) === "ripe");
  const prompt = app.store.run(orchard.data.card(posted.id).runId).prompt;
  assert.doesNotMatch(prompt, /please hurry/, "a chat's words are never put in front of the card's task");
  assert.equal(orchard.data.card(made.body.card.id).planted, true);
});

test("the shared board's cards move into Orchard once, lanes mapped, none planted", async (t) => {
  const now = new Date().toISOString();
  const { app, orchard } = await fixture(t);
  // The migration ran at start with no old table and marked itself done; the old table is made here and the mark taken
  // away, as on a data folder from before Orchard.
  app.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS board_cards(id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', lane TEXT NOT NULL, assignee TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, stuck INTEGER NOT NULL DEFAULT 0,
    run_id TEXT, history TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const project = app.store.projects.active(app.runtime.owner).id;
  const insert = app.store.sqlite.prepare("INSERT INTO board_cards(id,owner,project,title,lane,assignee,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  const ids = { todo: crypto.randomUUID(), doing: crypto.randomUUID(), review: crypto.randomUUID(), done: crypto.randomUUID() };
  for (const [old, id] of Object.entries(ids)) insert.run(id, app.runtime.owner, project, `old ${old}`, old, "assistant", now, now);
  app.store.delete("settings", app.runtime.owner, "orchard-migrated");
  const moved = orchard.data.migrate(() => "Garden");
  assert.equal(moved, 4);
  assert.equal(orchard.data.migrate(() => "Garden"), 0, "only once");
  const lanes = Object.fromEntries(Object.entries(ids).map(([old, id]) => [old, orchard.data.card(id).lane]));
  assert.deepEqual(lanes, { todo: "seed", doing: "seed", review: "ripe", done: "picked" });
  assert.ok(Object.values(ids).every((id) => !orchard.data.card(id).planted), "nothing moved here starts by itself");
});
