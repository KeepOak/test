/**
 * A conversation the owner hands to a Trunk is that Trunk's to look back on only while it is the one
 * chosen to answer there, and a Trunk's side of a room only while it still sits in that room. Every
 * look into the past keeps the same rule: a search, a read by id, the conversation's shape, a copy of
 * it, cards written up from it, and a task's record. A Trunk taken out of a room stays out of its side
 * after the room is deleted too. Real Trunk turns, a scripted model and the real tools throughout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { trunkAgent } from "../dist/trunks/memory-scope.js";

const lastRun = (app, sessionId) => app.store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId).id;
function outcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return JSON.stringify(done.data.result);
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  return failed ? `REFUSED ${failed.data.error}` : "NEVER RAN";
}
/** A tool called as `who` would call it (a Trunk's turn: `agent`; work a Trunk set going: `trunk`); what it gave back. */
async function as(app, who, name, input) {
  try { return `GAVE ${JSON.stringify(await app.registry.execute(name, input, { ...app.runtime.context(), ...who }))}`; }
  catch (error) { return `REFUSED ${error instanceof Error ? error.message : String(error)}`; }
}
/** The model writing up cards quotes the line it was given that holds the marker. */
const cards = ({ system, last }) => {
  if (!system.startsWith("You are reading one conversation")) return null;
  const line = String(last?.content ?? "").split("\n").find((one) => /OWNERAFTER9903/.test(one)) ?? "nothing new";
  return JSON.stringify({ cards: [{ title: "What was said", body: line.slice(0, 300), sourceTurn: line.slice(0, 300), confidence: 0.9 }] });
};

async function setup(t) {
  const asked = {};
  const { app, root, provider } = await fixture(t, [cards, ({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "").trim();
    if (text.startsWith("search ")) return call("history.search", { query: text.slice(7) });
    if (text === "read it") return call("history.read", asked.read);
    if (text === "tree it") return call("sessions.tree", { sessionId: asked.tree });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  app.trunks.ensureDefault(true); // These isolation tests exercise additional Trunks, never the person's default.
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["history.read"] });
  await app.trunks.introduced();
  /** A tool call in a Trunk's own chat; what it gave back. */
  const use = async (trunk, text, name) => {
    await app.trunks.say(trunk.id, text);
    return outcome(app, lastRun(app, app.trunks.records.find(trunk.id).chatSessionId), name); // its chat now, after a retire too
  };
  const said = (sessionId, text) => app.store.sqlite.prepare(
    "SELECT source_id FROM messages WHERE session_id=? AND json_extract(body,'$.content') LIKE ? ORDER BY id DESC LIMIT 1").get(sessionId, `%${text}%`)?.source_id;
  return { app, root, provider, ada, bo, use, asked, said };
}

test("a Trunk the owner takes a conversation back from reads nothing said there afterwards, by any look back", async (t) => {
  const { app, root, provider, ada, use, asked, said } = await setup(t);
  await mkdir(join(root, "workspace", "source"), { recursive: true });
  await writeFile(join(root, "workspace", "source", "notes.md"), "# Notes\n\nSample text.\n", "utf8");
  const notes = app.knowledgeBases.create(app.runtime.owner, { name: "Notes", sources: [{ kind: "folder", path: "source" }] });
  const first = await app.runtime.run({ prompt: "OWNERBEFORE9901 quillmoor, the owner's own", onTextDelta: () => undefined });
  const sessionId = app.store.run(first.id).sessionId;
  app.trunks.conversations.choose(sessionId, { trunkId: ada.id });
  const answered = await app.runtime.run({ prompt: "Ada, quillmoor question", sessionId, onTextDelta: () => undefined });
  // Her turn there is given the whole conversation, the owner's part before the hand-over too, so while
  // she answers there her looks back show her nothing new: the rule admits the whole of it or none.
  assert.ok(provider.requests.some((request) => request.messages.some((m) => m.role === "system" && /\nYou are Ada \(@/.test(m.content))
    && request.messages.some((m) => String(m.content).includes("OWNERBEFORE9901"))), "her turn there carried the owner's earlier line");
  assert.match(await use(ada, "search quillmoor", "history.search"), new RegExp(sessionId), "Ada reads it while she answers there");
  asked.read = { sessionId, messageId: said(sessionId, "OWNERBEFORE9901") };
  assert.match(await use(ada, "read it", "history.read"), /OWNERBEFORE9901/, "the owner's part before the hand-over too");
  asked.tree = sessionId;
  assert.doesNotMatch(await use(ada, "tree it", "sessions.tree"), /REFUSED/, "and sees its shape");
  const adaTurn = { agent: trunkAgent(ada.id) };
  assert.match(await as(app, adaTurn, "runs.export", { runId: answered.id }), /OWNERBEFORE9901/, "and her task's record there");
  // A specialist working for Ada still gets nothing of it.
  const specialist = { agent: "researcher", trunk: ada.id };
  assert.doesNotMatch(await as(app, specialist, "history.search", { query: "quillmoor" }), /OWNERBEFORE9901/);
  assert.match(await as(app, specialist, "sessions.tree", { sessionId }), /REFUSED Conversation not found/);

  app.trunks.conversations.choose(sessionId, { trunkId: null }); // the owner takes it back
  await app.runtime.run({ prompt: "OWNERAFTER9903 quillmoor secret, after Ada left", sessionId, onTextDelta: () => undefined });
  const after = said(sessionId, "OWNERAFTER9903");
  assert.doesNotMatch(await use(ada, "search OWNERAFTER9903", "history.search"), /OWNERAFTER9903/, "by search");
  asked.read = { sessionId, messageId: after };
  assert.match(await use(ada, "read it", "history.read"), /REFUSED .*not found/, "nor by its id");
  assert.match(await use(ada, "tree it", "sessions.tree"), /REFUSED .*not found/, "nor its shape");
  // Every other look into it goes the same way: a copy, cards written up from it, her own task's record there.
  assert.match(await as(app, adaTurn, "sessions.branch", { sessionId, messageId: after }), /^REFUSED Conversation not found/, "nor a copy of it");
  const proposed = await as(app, adaTurn, "knowledge.propose", { sessionId, collection: notes.id });
  assert.doesNotMatch(proposed, /OWNERAFTER9903/, "nor cards written up from it");
  assert.match(proposed, /^REFUSED That conversation is not one you participated in/);
  const exported = await as(app, adaTurn, "runs.export", { runId: answered.id });
  assert.doesNotMatch(exported, /OWNERAFTER9903/, "nor her own earlier task's record, which carries the whole conversation");
  assert.match(exported, /^REFUSED There is no task of yours/);
  // Work Ada set going without a turn of its own (a workflow's tool step) looks back as Ada, and is refused alike.
  // (It has no conversation of its own to leave out, so it may find her own chat, where she asked for the word.)
  assert.doesNotMatch(await as(app, { trunk: ada.id }, "history.search", { query: "OWNERAFTER9903" }), new RegExp(sessionId));
  // The owner's own look back still finds it.
  const owners = await app.registry.execute("history.search", { query: "OWNERAFTER9903" }, app.runtime.context());
  assert.equal(owners.results.some((row) => row.sessionId === sessionId), true);
  // Handed back to Ada, it is hers to read again, all of it: her turns there carry the whole conversation anyway.
  app.trunks.conversations.choose(sessionId, { trunkId: ada.id });
  const again = await use(ada, "search OWNERAFTER9903", "history.search");
  assert.match(again, /OWNERAFTER9903 quillmoor secret/);
  assert.match(again, new RegExp(sessionId));
});

test("a conversation handed from Ada to Bo is Bo's to read, all of it, and no longer Ada's", async (t) => {
  const { app, ada, bo, use } = await setup(t);
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "ADAPART7711 marrowfen for Ada", sessionId, onTextDelta: () => undefined });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  await app.runtime.run({ prompt: "BOPART7712 marrowfen for Bo now", sessionId, onTextDelta: () => undefined });
  assert.doesNotMatch(await use(ada, "search BOPART7712", "history.search"), /BOPART7712/, "Ada no longer reads it");
  assert.doesNotMatch(await use(ada, "search ADAPART7711", "history.search"), /ADAPART7711/, "not even her own part: the conversation is Bo's now");
  assert.match(await as(app, { agent: trunkAgent(ada.id) }, "sessions.tree", { sessionId }), /^REFUSED Conversation not found/);
  const bos = await use(bo, "search marrowfen", "history.search");
  assert.match(bos, /BOPART7712/, "Bo, who answers there now, does");
  assert.match(bos, /ADAPART7711/, "all of it, from before it was handed to him too");
});

test("a Trunk's own earlier chat and the conversation its routine started stay its own to look back on", async (t) => {
  const { app, ada, bo, use } = await setup(t);
  on(app, "routines");
  await app.trunks.say(ada.id, "ADACHAT7721 fenwick is on my list");
  app.trunks.retireChat(ada.id); // she carries on in a fresh chat; the earlier one is still hers (a search skips the one it is in)
  assert.match(await use(ada, "search fenwick", "history.search"), /ADACHAT7721/);
  assert.doesNotMatch(await use(bo, "search fenwick", "history.search"), /ADACHAT7721/);
  // A routine's run starts a conversation of its own, as that Trunk; the owner chose no one there, so it is hers.
  const routine = app.trunks.routines.create(ada.id, { name: "Look", prompt: "ROUTINE7731 kestrel, look around" });
  const fired = await app.scheduler.trigger(app.runtime.owner, routine.id, null, "local");
  const own = app.store.run(fired.id).sessionId;
  const found = await use(ada, "search kestrel", "history.search");
  assert.match(found, /ROUTINE7731/);
  assert.match(found, new RegExp(own), "found in the routine's own conversation");
  assert.doesNotMatch(await use(bo, "search kestrel", "history.search"), /ROUTINE7731/);
});

test("a Trunk taken out of a room no longer reads its side of the room, nor anything said there after it left", async (t) => {
  const { app, ada, bo, use, asked } = await setup(t);
  on(app, "rooms");
  const cy = app.trunks.create({ name: "Cy" });
  app.trunks.edit(cy.id, { permissions: ["history.read"] });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Bench", members: [ada.id, bo.id, cy.id] });
  app.trunks.rooms.send(room.id, { text: "ROOMBEFORE7741 heronsgate plan" });
  await app.trunks.rooms.settled(room.id);
  const side = app.trunks.rooms.get(room.id).memberSessions[ada.id];
  // While Ada sits in the room, her side of it is hers to look back on.
  assert.match(await use(ada, "search heronsgate", "history.search"), /ROOMBEFORE7741/);
  app.trunks.rooms.edit(room.id, { members: [bo.id, cy.id] }); // the owner takes Ada out
  app.trunks.rooms.send(room.id, { text: "ROOMAFTER7742 heronsgate, after Ada left" });
  await app.trunks.rooms.settled(room.id);
  assert.doesNotMatch(await use(ada, "search heronsgate", "history.search"), /ROOM(BEFORE7741|AFTER7742)/, "nothing of the room, by search");
  asked.tree = side;
  assert.match(await use(ada, "tree it", "sessions.tree"), /REFUSED .*not found/, "nor her side's shape");
  const turn = app.store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(side).id;
  assert.match(await as(app, { agent: trunkAgent(ada.id) }, "runs.export", { runId: turn }), /^REFUSED There is no task of yours/,
    "nor the record of her own turn there, which carries her side");
  // The room's own conversation was never hers to read: turns are taken on each member's side.
  asked.tree = room.sessionId;
  assert.match(await use(ada, "tree it", "sessions.tree"), /REFUSED .*not found/, "nor the room's own");
  // Bo, still in the room, reads on his side what was said after Ada left.
  assert.match(await use(bo, "search heronsgate", "history.search"), /ROOMAFTER7742/);
  // Seated again, her side is hers again.
  app.trunks.rooms.edit(room.id, { members: [ada.id, bo.id, cy.id] });
  assert.match(await use(ada, "search ROOMBEFORE7741", "history.search"), /ROOMBEFORE7741/);
});

test("a Trunk taken out of a room stays out of its side once the owner deletes the room; a Trunk still seated keeps its own", async (t) => {
  const { app, ada, bo, use, asked, said } = await setup(t);
  on(app, "rooms");
  const cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Bench", members: [ada.id, bo.id, cy.id] });
  app.trunks.rooms.send(room.id, { text: "ROOMBEFORE7741 heronsgate plan" });
  await app.trunks.rooms.settled(room.id);
  const { [ada.id]: side, [bo.id]: boSide } = app.trunks.rooms.get(room.id).memberSessions;
  // While Ada sits in the room, her side is hers to read, by its id too.
  asked.read = { sessionId: side, messageId: said(side, "ROOMBEFORE7741") };
  assert.match(await use(ada, "read it", "history.read"), /ROOMBEFORE7741/);
  app.trunks.rooms.edit(room.id, { members: [bo.id, cy.id] }); // the owner takes Ada out
  app.trunks.rooms.send(room.id, { text: "ROOMAFTER7742 heronsgate, after Ada left" });
  await app.trunks.rooms.settled(room.id);
  app.trunks.rooms.remove(room.id); // and later deletes the room
  const search = await use(ada, "search heronsgate", "history.search");
  assert.match(search, /^\{"results"/);
  assert.doesNotMatch(search, /ROOM(BEFORE7741|AFTER7742)/, "nothing of her old side, by search");
  assert.match(await use(ada, "read it", "history.read"), /REFUSED .*not found/, "nor by its id");
  asked.tree = side;
  assert.match(await use(ada, "tree it", "sessions.tree"), /REFUSED .*not found/, "nor its shape");
  assert.match(await as(app, { agent: trunkAgent(ada.id) }, "runs.export", { runId: lastRun(app, side) }), /^REFUSED There is no task of yours/,
    "nor the record of her own turn there");
  // Bo sat in the room when it was deleted: his side stays his own.
  const bos = await use(bo, "search heronsgate", "history.search");
  assert.match(bos, /ROOMAFTER7742/);
  assert.match(bos, new RegExp(boSide), "on his own side");
  // The owner reads all of it.
  const owners = await app.registry.execute("history.search", { query: "ROOMBEFORE7741" }, app.runtime.context());
  assert.equal(owners.results.some((row) => row.sessionId === side), true);
  // Handed to Bo afterwards, Ada's old side is his to read once he answers there: only Ada is kept out of it.
  app.trunks.conversations.choose(side, { trunkId: bo.id });
  await app.runtime.run({ prompt: "BOSIDE7743 heronsgate, for Bo now", sessionId: side, onTextDelta: () => undefined });
  assert.match(await use(bo, "search ROOMBEFORE7741", "history.search"), new RegExp(side), "Bo, who answers there now, reads it");
});

test("a Trunk seated again before its room is deleted keeps its side of the room afterwards", async (t) => {
  const { app, ada, bo, use, asked, said } = await setup(t);
  on(app, "rooms");
  const cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Loft", members: [ada.id, bo.id, cy.id] });
  app.trunks.rooms.send(room.id, { text: "ROOMSEAT7751 wrenfield plan" });
  await app.trunks.rooms.settled(room.id);
  const side = app.trunks.rooms.get(room.id).memberSessions[ada.id];
  app.trunks.rooms.edit(room.id, { members: [bo.id, cy.id] }); // the owner takes Ada out,
  app.trunks.rooms.edit(room.id, { members: [ada.id, bo.id, cy.id] }); // seats her again,
  app.trunks.rooms.remove(room.id); // and then deletes the room
  const found = await use(ada, "search wrenfield", "history.search");
  assert.match(found, /ROOMSEAT7751/);
  assert.match(found, new RegExp(side), "on her own side");
  asked.read = { sessionId: side, messageId: said(side, "ROOMSEAT7751") };
  assert.match(await use(ada, "read it", "history.read"), /ROOMSEAT7751/, "by its id too");
  asked.tree = side;
  assert.doesNotMatch(await use(ada, "tree it", "sessions.tree"), /REFUSED/, "and its shape");
});

test("a Trunk taken out of a room cannot bring its old side in with history.attach once the room is deleted, as its turn or its workflow step", async (t) => {
  // history.attach (#159) reached a deleted room's side only through canAccessSession: while the room stands its
  // sides are hidden, but once it is deleted the side is an ordinary conversation, and only the mark keeps Ada out.
  const { app, ada, bo } = await setup(t);
  on(app, "rooms");
  const cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Bench", members: [ada.id, bo.id, cy.id] });
  app.trunks.rooms.send(room.id, { text: "ROOMBEFORE7741 heronsgate plan" });
  await app.trunks.rooms.settled(room.id);
  const side = app.trunks.rooms.get(room.id).memberSessions[ada.id];
  app.trunks.rooms.edit(room.id, { members: [bo.id, cy.id] }); // the owner takes Ada out
  app.trunks.rooms.remove(room.id); // and later deletes the room
  // The control: the side is an ordinary conversation now, and the owner brings it in.
  assert.match(await as(app, {}, "history.attach", { conversation: side }), /^GAVE .*ROOMBEFORE7741/);
  for (const who of [{ agent: trunkAgent(ada.id) }, { trunk: ada.id }]) {
    assert.match(await as(app, who, "history.attach", { conversation: side }), /^REFUSED There is no conversation of yours/, JSON.stringify(who));
    assert.match(await as(app, who, "history.attach", { conversation: "heronsgate" }), /^REFUSED No other conversation mentions/, JSON.stringify(who));
  }
});
