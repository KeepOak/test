/**
 * R17-A: Trunks, Branch's named long-lived agents — the record, the three-field create, the permanent
 * chat, memory, keys, pictures, routines, teaching, export and reach. Rooms and messages between
 * Trunks are in trunks-rooms.test.mjs. Every part ships off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { visibleTo } from "../dist/index.js";
import { offLimitsToShortLivedKeys, startServer } from "../dist/server.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { faceFor, pictureAddress, settleAvatar } from "../dist/trunks/avatar.js";
import { keyPlan } from "../dist/trunks/accounts.js";
import { saveAccountsSettings, sessionChoice } from "../dist/accounts/settings.js";
import { saveRetentionSettings } from "../dist/retention.js";
import { saveOrchestrationSettings } from "../dist/orchestration.js";
import { slug } from "../dist/trunks/record.js";
import { trunkPermissions } from "../dist/trunks/shape.js";
import { HANDLERS } from "../dist/commands/handlers.js";
import { lookup } from "../dist/commands/catalog.js";
import { call, fixture, on } from "./trunks-helpers.mjs";

test("every part ships off, says so in one sentence, and advertises nothing", async (t) => {
  const { app } = await fixture(t);
  // The owner's rule (ships on, 2026-09-26): every part but choosing a Trunk in any conversation ships "when needed";
  // what "off" does is tested by switching each part off.
  assert.deepEqual(app.trunks.modes(), { trunks: "when-needed", rooms: "when-needed", messages: "when-needed", routines: "when-needed", teach: "when-needed", conversations: "off" });
  for (const part of ["trunks", "rooms", "messages", "routines", "teach"]) app.trunks.setMode(part, { mode: "off" });
  assert.deepEqual(app.trunks.modes(), { trunks: "off", rooms: "off", messages: "off", routines: "off", teach: "off", conversations: "off" }); // phase2/rooms
  assert.throws(() => app.trunks.create({ name: "Ada" }), /Trunks, your named assistants is switched off/);
  assert.equal(app.registry.names().includes("trunk.message"), false);
  // A part cannot be on while Trunks themselves are off.
  app.trunks.setMode("messages", { mode: "on" });
  assert.equal(app.trunks.modes().messages, "off");
  assert.equal(app.registry.names().includes("trunk.message"), false);
  app.trunks.setMode("trunks", { mode: "when-needed" });
  assert.equal(app.trunks.modes().messages, "on");
  assert.ok(app.registry.names().includes("trunk.message"));
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, ["trunk.message"]).preload.map((p) => p.name), ["trunk.message"]);
  app.trunks.setMode("messages", { mode: "off" });
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, ["trunk.message"]).hidden, ["trunk.message"]);
  assert.equal(app.registry.names().includes("trunk.message"), false);
});

test("three fields make a Trunk; it introduces itself in its own pinned conversation, and every field can be edited", async (t) => {
  const { app, provider } = await fixture(t);
  on(app);
  const ada = app.trunks.create({ name: "Ada Lovelace", title: "Researcher", description: "Reads papers and sums them up" });
  assert.equal(ada.handle, "ada-lovelace");
  assert.deepEqual(ada.reach, { channels: [], commands: false }, "every reach starts off");
  assert.deepEqual(ada.avatar, { kind: "face", seed: "Ada Lovelace", locked: false });
  await app.trunks.introduced();
  const said = app.store.messages(ada.chatSessionId).filter((m) => m.role === "assistant");
  assert.equal(said[0].content, "Hello, I am Ada Lovelace.");
  const system = provider.requests.at(-1).messages.find((m) => m.role === "system").content;
  assert.match(system, /You are Ada Lovelace \(@ada-lovelace\)/);
  assert.match(system, /Your role: Researcher\./);
  // A second Trunk with the same name gets its own @name; reserved words are never taken.
  assert.equal(app.trunks.create({ name: "Ada Lovelace" }).handle, "ada-lovelace-2");
  assert.equal(app.trunks.create({ name: "Everyone" }).handle, "everyone-2");
  assert.equal(slug("Émile  Zola!"), "emile-zola");
  const edited = app.trunks.edit(ada.id, { name: "Ada", instructions: "Answer in French.", model: "", reasoning: "high", style: "researcher",
    skills: ["papers"], sharedFacts: false, hidden: true, section: "Work", pinned: true, order: 3 });
  assert.equal(edited.handle, "ada", "the @name follows a rename");
  assert.equal(edited.avatar.seed, "Ada", "an unlocked face follows the name");
  assert.equal(edited.title, "Researcher", "fields not sent are kept");
  assert.equal(edited.chatSessionId, ada.chatSessionId);
  assert.throws(() => app.trunks.edit(ada.id, { name: "" }), /name/);
  assert.throws(() => app.trunks.edit(ada.id, { reach: { channels: ["telegram"], commands: "yes" } }));
  await app.trunks.introduced();
});

test("a Trunk's turn carries its instructions, its tools and its memory scope, however the message arrives", async (t) => {
  const rules = [({ last, system }) => (/remember this/.test(last?.content ?? "") && /\nYou are Bo \(@/.test(system)
    ? call("memory.put", { text: "Bo's own note", source: "trunk" }) : null)];
  const { app, provider } = await fixture(t, rules);
  on(app);
  const bo = app.trunks.create({ name: "Bo", title: "Helper" });
  await app.trunks.introduced();
  const owner = app.runtime.context();
  await app.registry.execute("memory.put", { text: "Owner secret", source: "owner" }, owner);
  await app.registry.execute("memory.put", { text: "Shared plan", source: "owner", scope: "shared" }, owner);
  const run = await app.runtime.run({ prompt: "remember this", sessionId: bo.chatSessionId });
  assert.equal(run.status, "completed");
  const turn = app.store.events(run.id).find((e) => e.kind === "trunk.turn");
  assert.equal(turn.data.trunkId, bo.id);
  const saved = app.store.list("memory", app.store.profiles.scope()).find((r) => r.data.text === "Bo's own note");
  assert.equal(saved.data.scope, `agent:trunk:${bo.id}`, "what a Trunk learns is its own");
  const agent = `trunk:${bo.id}`;
  const facts = app.store.list("memory", app.store.profiles.scope());
  const seen = () => facts.filter((r) => visibleTo(r, agent)).map((r) => r.data.text).sort();
  assert.deepEqual(seen(), ["Bo's own note", "Shared plan"]);
  app.trunks.edit(bo.id, { sharedFacts: false });
  assert.deepEqual(seen(), ["Bo's own note"], "a Trunk set to keep to itself does not read shared facts");
  // No commands unless its reach allows them; a reviewing style takes every writing tool away.
  const started = app.store.events(run.id).find((e) => e.kind === "run.started").data.permissions;
  assert.ok(app.registry.permissions().includes("code.execute"));
  assert.equal(started.includes("code.execute"), false);
  app.trunks.edit(bo.id, { reach: { channels: [], commands: true } });
  const again = await app.runtime.run({ prompt: "hello", sessionId: bo.chatSessionId });
  assert.ok(app.store.events(again.id).find((e) => e.kind === "run.started").data.permissions.includes("code.execute"));
  // A Trunk's own chat is not a delegated run: the reviewer pass still happens there.
  saveOrchestrationSettings(app.store, app.runtime.owner, { verify: true });
  const checked = await app.runtime.run({ prompt: "hello", sessionId: bo.chatSessionId });
  assert.ok(app.store.events(checked.id).some((e) => e.kind === "verify.started"), "the reviewer runs in a Trunk chat");
  saveOrchestrationSettings(app.store, app.runtime.owner, {});
  app.trunks.edit(bo.id, { style: "critic" });
  const critic = await app.runtime.run({ prompt: "hello", sessionId: bo.chatSessionId });
  assert.equal(app.store.events(critic.id).find((e) => e.kind === "run.started").data.permissions.includes("memory.write"), false);
  // A queued message runs as the Trunk too; an ordinary conversation does not.
  const plain = await app.runtime.run({ prompt: "hello" });
  assert.equal(app.store.events(plain.id).some((e) => e.kind === "trunk.turn"), false);
  assert.doesNotMatch(provider.requests.at(-1).messages[0].content, /You are Bo \(@/);
  // With Trunks switched off, its conversation still runs as the Trunk: its shape only ever narrows
  // (integrator, R17-A; tests/trunks-integrator.test.mjs has the case that mattered).
  app.trunks.setMode("trunks", { mode: "off" });
  const off = await app.runtime.run({ prompt: "hello", sessionId: bo.chatSessionId });
  assert.equal(app.store.events(off.id).some((e) => e.kind === "trunk.turn"), true);
});

test("the permissions a Trunk gets never widen, and tool servers are off unless named", () => {
  const trunk = { permissions: [], reach: { commands: false }, mcpServers: ["notes"] };
  const available = ["files.read", "shell.execute", "mcp.notes.0123456789abcdef", "mcp.mail.0123456789abcdef", "mcp.read"];
  assert.deepEqual(trunkPermissions(trunk, available), ["files.read", "mcp.notes.0123456789abcdef", "mcp.read"]);
  assert.deepEqual(trunkPermissions(trunk, available, ["files.read"]), ["files.read"], "never more than the caller allowed");
  assert.deepEqual(trunkPermissions({ ...trunk, permissions: ["files.read", "web.read"] }, available), ["files.read"]);
});

test("retiring the chat keeps it in history, the history rule never sweeps a Trunk's chat, and a specialist can be brought across", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const first = cy.chatSessionId;
  const next = app.trunks.retireChat(cy.id);
  assert.notEqual(next.chatSessionId, first);
  assert.deepEqual(next.retiredChats, [first]);
  assert.ok(app.store.ownsSession(app.runtime.owner, first), "the old chat stays in history");
  assert.equal(app.trunks.keeps(next.chatSessionId), true);
  assert.equal(app.trunks.keeps(first), false);
  // The wired rule itself: ten days on, everything is old, and only the Trunk's chat is left out.
  saveRetentionSettings(app.store, app.runtime.owner, { enabled: true, keepDays: 1 });
  app.store.createSession(app.runtime.owner);
  app.retention.now = () => Date.now() + 10 * 86_400_000;
  const swept = app.retention.propose().conversations.map((entry) => entry.sessionId);
  assert.ok(swept.includes(first), "a retired chat is ordinary history");
  assert.equal(swept.includes(next.chatSessionId), false, "the Trunk's own chat is never proposed");
  // A specialist with an evaluated version comes across with its instructions, style and permissions.
  const id = "11111111-2222-4333-8444-555555555555";
  const definition = { name: "Reviewer", instructions: "Review carefully.", style: "critic", permissions: ["files.read"], evaluation: { prompt: "x", checks: [{ path: "a", expected: "b" }] } };
  app.store.save("specialists", app.runtime.owner, id, { version: 1, definition, evaluationPassed: true, activeVersion: 1, previousActive: null, history: [] });
  const brought = app.trunks.fromSpecialist(id);
  assert.equal(brought.name, "Reviewer");
  assert.equal(brought.style, "critic");
  assert.deepEqual(brought.permissions, ["files.read"]);
  assert.match(brought.instructions, /^Review carefully\./);
  assert.equal(brought.fromSpecialist, id);
  await app.trunks.introduced();
  // Removing a Trunk leaves its conversations in history.
  assert.deepEqual(app.trunks.remove(cy.id), { removed: true });
  assert.ok(app.store.ownsSession(app.runtime.owner, next.chatSessionId));
});

test("pictures: a face from the name, an uploaded picture, a generated one, and nothing that is not a picture", async (t) => {
  assert.deepEqual(faceFor("Ada"), faceFor(" ada "));
  assert.ok(faceFor("Ada").series >= 1 && faceFor("Ada").series <= 8);
  assert.deepEqual(settleAvatar({ kind: "face", seed: "Old", locked: true }, "New"), { kind: "face", seed: "Old", locked: true });
  assert.throws(() => pictureAddress(Buffer.from("x"), "text/html"), /PNG, JPEG or WebP/);
  const { app } = await fixture(t);
  on(app);
  const di = app.trunks.create({ name: "Di" });
  const png = pictureAddress(Buffer.from([137, 80, 78, 71]), "image/png");
  assert.equal((await app.trunks.setAvatar(di.id, { kind: "image", dataUrl: png })).avatar.dataUrl, png);
  await assert.rejects(app.trunks.setAvatar(di.id, { kind: "image", dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }));
  assert.equal((await app.trunks.setAvatar(di.id, { kind: "face", locked: true })).avatar.locked, true);
  // The picture model is asked through the tool gate; with none connected it says so plainly.
  await assert.rejects(app.trunks.setAvatar(di.id, { kind: "generate", prompt: "a fox" }), /cannot make pictures|picture/);
  await app.trunks.introduced();
});

test("keys: copied from the owner by default, a sign-in never copied, and a pick is the Trunk conversation's account choice", async (t) => {
  const pools = [{ id: "openai", label: "OpenAI", accounts: [{ id: "k1", label: "Work key", signIn: false }] },
    { id: "chatgpt", label: "ChatGPT", accounts: [{ id: "me", label: "My sign-in", signIn: true }] }];
  const plan = keyPlan({ copyFromOwner: true, accounts: {} }, pools);
  assert.deepEqual(plan.choices, { openai: null, chatgpt: null });
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /ChatGPT: .*never used for a Trunk/);
  // mac7/lockdown-fix: a sign-in is not taken even when picked, and uncopied keys say so.
  const picked = keyPlan({ copyFromOwner: false, accounts: { chatgpt: "me" } }, pools);
  assert.deepEqual(picked.choices, { openai: null, chatgpt: null });
  assert.match(picked.notes.join(" "), /OpenAI: your keys are not copied.*does not answer/);
  const { app } = await fixture(t);
  on(app);
  const ed = app.trunks.create({ name: "Ed" });
  const keys = app.trunks.keys(ed.id);
  assert.equal(keys.connected, false);
  assert.match(keys.note, /uses your own keys/);
  // With several accounts switched on, the Trunk's pick becomes its own conversation's choice.
  const at = "2026-09-17T00:00:00.000Z";
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [
    { pool: "openai", kind: "api-key", accounts: [{ id: "primary", label: "First key", createdAt: at }, { id: "0a0b0c0d", label: "Work key", createdAt: at }] },
    { pool: "chatgpt", kind: "chatgpt", accounts: [{ id: "primary", label: "First sign-in", createdAt: at }] }] });
  const live = app.trunks.keys(ed.id);
  assert.equal(live.connected, true);
  assert.equal(live.note, null);
  assert.match(live.plan.notes.join(" "), /chatgpt: .*never used for a Trunk/);
  app.trunks.edit(ed.id, { keys: { copyFromOwner: true, accounts: { openai: "0a0b0c0d" } } });
  assert.deepEqual(sessionChoice(app.store, app.runtime.owner, ed.chatSessionId), { openai: "0a0b0c0d" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: true, accounts: {} } });
  assert.deepEqual(sessionChoice(app.store, app.runtime.owner, ed.chatSessionId), {});
  await app.trunks.introduced();
});

test("routines a Trunk owns run as it and report in its own conversation", async (t) => {
  const { app } = await fixture(t, [({ last }) => (/Check the news/.test(last?.content ?? "") ? "Nothing new today." : null)]);
  on(app);
  const fi = app.trunks.create({ name: "Fi" });
  await app.trunks.introduced();
  app.trunks.setMode("routines", { mode: "off" }); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  assert.throws(() => app.trunks.routines.create(fi.id, { name: "News", prompt: "Check the news" }), /Routines a Trunk owns is switched off/);
  app.trunks.setMode("routines", { mode: "on" });
  const routine = app.trunks.routines.create(fi.id, { name: "News", prompt: "Check the news", dailyAt: "08:00", timezone: "UTC" });
  const listed = app.trunks.routines.list(fi.id);
  assert.equal(listed.length, 1);
  assert.match(String(app.store.get("schedules", app.runtime.owner, routine.id).data.prompt), /^\[Trunk @fi\] News/);
  const run = await app.scheduler.trigger(app.runtime.owner, routine.id, null, "local");
  assert.equal(app.store.events(run.id).find((e) => e.kind === "trunk.turn").data.trunkId, fi.id);
  assert.ok(app.store.messages(fi.chatSessionId).some((m) => m.content === 'Routine "News": Nothing new today.'));
  app.trunks.remove(fi.id);
  assert.equal(app.store.get("schedules", app.runtime.owner, routine.id), undefined, "a removed Trunk's routines go with it");
});

test("teaching by showing: what the owner did once becomes the Trunk's workflow", async (t) => {
  const { app } = await fixture(t, [({ last }) => (/write the report/.test(last?.content ?? "") ? call("files.write", { path: "report.md", content: "# Report" })
    : last?.role === "tool" ? "Written." : null)]);
  on(app, "routines");
  const gu = app.trunks.create({ name: "Gu" });
  await app.trunks.introduced();
  app.trunks.setMode("teach", { mode: "off" }); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  assert.throws(() => app.trunks.teaching.watch(gu.id), /Teaching a Trunk/);
  app.trunks.setMode("teach", { mode: "on" });
  assert.throws(() => app.trunks.teaching.save(gu.id, {}), /Watch me/);
  app.trunks.teaching.watch(gu.id);
  assert.throws(() => app.trunks.teaching.save(gu.id, {}), /Nothing has finished/);
  const shown = await app.runtime.run({ prompt: "write the report" });
  assert.equal(shown.status, "completed");
  const taught = app.trunks.teaching.save(gu.id, { name: "Weekly report", dailyAt: "09:00" });
  assert.equal(taught.steps, 1);
  assert.equal(taught.workflow.name, "Weekly report");
  assert.ok(taught.routine);
  assert.deepEqual(app.trunks.records.get(gu.id).taught.map((x) => x.workflowId), [taught.workflow.id]);
  assert.ok(app.store.get("schedules", app.runtime.owner, taught.routine.id).data.permissions.includes("workflows.manage"));
  assert.equal(app.trunks.teaching.watching(gu.id), null);
});

test("a Trunk as one file: nothing it holds and no reach travels with it", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const ha = app.trunks.create({ name: "Ha", title: "Planner" });
  app.trunks.edit(ha.id, { instructions: "Plan first.", reach: { channels: ["telegram"], commands: true }, keys: { copyFromOwner: false, accounts: { openai: "k" } } });
  const file = app.trunks.exportFile(ha.id);
  assert.equal(file.format, "branch-trunk/1");
  assert.equal("reach" in file.trunk || "keys" in file.trunk, false);
  const text = JSON.stringify(file);
  assert.doesNotMatch(text, /chatSessionId|telegram/);
  const copy = app.trunks.importFile(JSON.parse(text));
  assert.notEqual(copy.id, ha.id);
  assert.equal(copy.instructions, "Plan first.");
  assert.deepEqual(copy.reach, { channels: [], commands: false });
  assert.deepEqual(copy.keys, { copyFromOwner: true, accounts: {} });
  assert.throws(() => app.trunks.importFile({ ...file, trunk: { ...file.trunk, reach: { channels: ["x"], commands: true } } }));
  await app.trunks.introduced();
});

test("a chat app reaches a Trunk only where its switch allows it", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const io = app.trunks.create({ name: "Io" });
  await app.trunks.introduced();
  assert.match(app.channels.trunkReach("telegram", io.chatSessionId), /Io does not answer on telegram/);
  app.trunks.edit(io.id, { reach: { channels: ["telegram"], commands: false } });
  assert.equal(app.channels.trunkReach("telegram", io.chatSessionId), null);
  assert.match(app.channels.trunkReach("discord", io.chatSessionId), /discord/);
  const plain = await app.runtime.run({ prompt: "hi" });
  assert.equal(app.channels.trunkReach("discord", plain.sessionId), null);
});

test("the window's routes and /trunk: create, roster, talk, switch, and a short-lived key limited to talking", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const ask = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  // The owner's rule (ships on, 2026-09-26): Trunks ship "when needed"; "off" is tested by switching it off.
  assert.equal((await ask("/api/trunks")).body.modes.trunks, "when-needed");
  assert.equal((await ask("/api/trunks/switch", { part: "trunks", mode: "off" })).status, 200);
  const first = await ask("/api/trunks");
  assert.deepEqual(first.body.trunks, []);
  assert.equal(first.body.modes.trunks, "off");
  assert.equal((await ask("/api/trunks", { name: "Jo" })).status, 409);
  assert.equal((await ask("/api/trunks/switch", { part: "trunks", mode: "on" })).status, 200);
  const made = await ask("/api/trunks", { name: "Jo", title: "Writer", description: "Writes things" });
  assert.equal(made.status, 200);
  const id = made.body.trunk.id;
  await app.trunks.introduced();
  const roster = (await ask("/api/trunks")).body.trunks;
  assert.equal(roster[0].unread, 1);
  assert.match(roster[0].latest.text, /Hello, I am Jo/);
  assert.equal((await ask(`/api/trunks/${id}/seen`, {})).status, 200);
  assert.equal((await ask("/api/trunks")).body.trunks[0].unread, 0);
  const said = await ask(`/api/trunks/${id}/say`, { text: "hello" });
  assert.equal(said.body.output, "Done.");
  assert.equal((await ask(`/api/trunks/${id}`)).body.trunk.handle, "jo");
  assert.equal((await ask(`/api/trunks/${id}`, { title: "Editor" })).body.trunk.title, "Editor");
  assert.equal((await ask(`/api/trunks/${id}/export`)).body.format, "branch-trunk/1");
  assert.equal((await ask("/api/trunks/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await ask("/api/trunks", { name: "" })).status, 400);
  // /trunk from the shared table.
  assert.equal(lookup("/trunks").name, "trunk");
  const host = { runtime: app.runtime, requireOwner: () => undefined };
  const listed = await HANDLERS.trunk({ host, surface: "window", argument: "", sessionId: undefined, access: "full", mode: "on" });
  assert.match(listed.text, /@jo — Jo, Editor/);
  const talked = await HANDLERS.trunk({ host, surface: "window", argument: "@jo hello there", sessionId: undefined, access: "full", mode: "on" });
  assert.equal(talked.text, "@jo: Done.");
  const opened = await HANDLERS.trunk({ host, surface: "window", argument: "jo", sessionId: undefined, access: "full", mode: "on" });
  assert.deepEqual(opened.client, { do: "open-session", id: made.body.trunk.chatSessionId });
  assert.match((await HANDLERS.trunk({ host, surface: "window", argument: "jo hi", sessionId: undefined, access: "read", mode: "on" })).text, /only look/);
  // A short-lived key may talk to a Trunk and to a room, and nothing else here.
  assert.equal(offLimitsToShortLivedKeys("POST", `/api/trunks/${id}/say`), null);
  assert.equal(offLimitsToShortLivedKeys("POST", `/api/trunks/rooms/${id}/send`), null);
  for (const path of ["/api/trunks", "/api/trunks/switch", `/api/trunks/${id}`, `/api/trunks/${id}/avatar`, `/api/trunks/rooms/${id}/answer`])
    assert.match(offLimitsToShortLivedKeys("POST", path), /short-lived key/);
  assert.equal((await ask(`/api/trunks/${id}/remove`, {})).body.removed, true);
});
