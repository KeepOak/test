import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, standardSuite } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => () => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
function scripted(initial) {
  const provider = { name: "scripted", requests: [], steps: initial, index: 0, async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0].content;
    const roleStep = provider.byRole?.find(([needle]) => system.includes(needle));
    if (roleStep) return roleStep[1](request);
    return provider.steps[Math.min(provider.index++, provider.steps.length - 1)](request);
  } };
  provider.reset = (steps) => { provider.steps = steps; provider.index = 0; };
  return provider;
}
async function fixture(t, steps = [say("ok")], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-teams-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
  };
  return { app, root, provider, api, server };
}
/** An evaluated, promoted specialist the runtime will delegate to. */
async function specialist(app, name) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", { name, instructions: `You are the ${name}.`, permissions: ["files.read"], evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] } }, context);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

test("a team with roles fans a task out to every member and keeps the answers in a shared room that survives a restart", async (t) => {
  const { app, root, provider, api } = await fixture(t);
  const planner = await specialist(app, "planner"), critic = await specialist(app, "critic");
  provider.byRole = [["You are the planner", say("Plan: three steps")], ["You are the critic", say("Critique: step two is weak")]];
  const team = await api("teams", { name: "Launch crew", purpose: "Ship the newsletter.", members: [{ specialistId: planner, role: "Planner", brief: "Lay out the steps." }, { specialistId: critic, role: "Critic" }] });
  assert.match(team.roomSessionId, /^[a-f0-9-]{36}$/);
  await assert.rejects(api("teams", { name: "Dupes", members: [{ specialistId: planner, role: "A" }, { specialistId: planner, role: "B" }] }), /one role per team/);
  provider.reset([say("team parent")]);
  const result = await api(`teams/${team.id}/run`, { prompt: "How do we launch on Friday?" });
  assert.deepEqual(result.answers.map((a) => [a.role, a.output]), [["Planner", "Plan: three steps"], ["Critic", "Critique: step two is weak"]]);
  const room = (await api(`teams/${team.id}/room`)).messages;
  assert.deepEqual(room.map((m) => m.role), ["system", "user", "assistant", "assistant"]);
  assert.match(room[2].content, /^\[Planner\] Plan/);
  assert.match(room[3].content, /^\[Critic\] Critique/);
  const plannerRequest = provider.requests.filter((r) => /You are the planner/.test(r.messages[0].content)).at(-1);
  assert.match(plannerRequest.messages.find((m) => m.role === "user").content, /Your role in team "Launch crew": Planner\. Lay out the steps\./);
  // Restart: a fresh instance on the same data still has the team and the room history.
  await app.close();
  const again = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  try {
    assert.equal(again.teams.list()[0].name, "Launch crew");
    assert.equal(again.teams.room(team.id).length, 4);
    assert.deepEqual(again.teams.remove(team.id), { removed: true });
  } finally { await again.close(); }
});

test("a chat linked to a conversation continues that very conversation, so both surfaces see one ordered history", async (t) => {
  const { app, api } = await fixture(t, [say("from the web"), say("from telegram"), say("web again")]);
  const first = await app.runtime.run({ prompt: "hello from the web" });
  const sent = [];
  const fake = { id: "tg", kind: "telegram", botName: () => "Bot", async start(onMessage) { fake.deliver = onMessage; }, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); return "m1"; } };
  await app.channels.attach(fake, { activation: "always", pairing: false, allowlist: ["42"] });
  await assert.rejects(api("channels/link", { channel: "tg", chatId: "501", sessionId: "00000000-0000-4000-8000-000000000000" }), /Session not found/);
  const linked = await api("channels/link", { channel: "tg", chatId: "501", sessionId: first.sessionId });
  assert.equal(linked.sessionId, first.sessionId);
  await fake.deliver({ channel: "tg", chatId: "501", chatKind: "direct", senderId: "42", senderName: "Ann", text: "and from my phone", addressed: true, messageId: "9" });
  assert.equal(sent[0].text, "from telegram");
  const third = await app.runtime.run({ prompt: "back on the web", sessionId: first.sessionId });
  assert.equal(third.status, "completed");
  const history = app.store.messages(first.sessionId).filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`);
  assert.deepEqual(history, ["user: hello from the web", "assistant: from the web", "user: and from my phone", "assistant: from telegram", "user: back on the web", "assistant: web again"]);
  const chats = (await api("channels")).chats;
  assert.equal(chats.find((c) => c.chatId === "501").sessionId, first.sessionId);
});

test("after an interruption, an unknown-outcome write is not repeated until the state has been checked", async (t) => {
  const steps = [call("files.write", { path: "note.txt", content: "again" }), call("files.read", { path: "note.txt" }, "c2"), call("files.write", { path: "note.txt", content: "again" }, "c3"), say("resolved")];
  const { app } = await fixture(t, steps);
  const { writeFile: write } = await import("node:fs/promises");
  await write(join(app.runtime.workspace, "note.txt"), "before");
  const first = app.store.createRun("local", "write my note");
  app.store.event(first.id, "run.started", { source: "owner", permissions: [app.registry.permissionOf("files.write"), app.registry.permissionOf("files.read")],
    deadlineMs: 30_000, depth: 0, delegates: false, dryRun: false, ownCopy: false });
  app.store.message(first.sessionId, { role: "user", content: "write my note" });
  app.store.message(first.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "again" }) }] });
  app.store.finish(first.id, "interrupted", "Process stopped before completion; side effects were not replayed");
  const resumed = await app.runtime.resume(first.id);
  assert.equal(resumed.status, "completed");
  const tools = app.store.messages(first.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.match(tools[1].error, /outcome is unknown\. Check the actual state first/);
  assert.equal(tools[2].ok, true, "the read was allowed");
  assert.equal(tools[3].ok, true, "after checking, the same write is allowed again");
  const events = app.store.events(resumed.id).map((e) => e.kind);
  assert.ok(events.includes("reconciliation.required"));
  assert.equal(events.filter((k) => k === "tool.completed" && true).length >= 2, true);
});

test("a skill registry can be browsed and a listed skill installed only after its fingerprint matches, disabled until activated", async (t) => {
  const good = "---\nname: registry-helper\ndescription: Helps from a registry.\n---\nBe helpful.\n";
  const sha = createHash("sha256").update(good, "utf8").digest("hex");
  const server = createServer((req, res) => {
    if (req.url === "/index.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ format: "branch-skill-registry", version: 1, name: "Test registry", skills: [
      { id: "helper", name: "registry-helper", description: "Helps from a registry.", url: `http://127.0.0.1:${server.address().port}/helper.md`, sha256: sha },
      { id: "tampered", name: "tampered", description: "Fingerprint will not match.", url: `http://127.0.0.1:${server.address().port}/helper.md`, sha256: "0".repeat(64) },
    ] })); }
    if (req.url === "/helper.md") { res.writeHead(200, { "content-type": "text/markdown" }); return res.end(good); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  const blocked = await fixture(t);
  await assert.rejects(blocked.api("registry/browse", { url }), /private or local address/, "the network policy applies to registries too");
  const { app, api } = await fixture(t, [say("ok")], { web: { allowPrivateAddresses: true } });
  const index = await api("registry/browse", { url });
  assert.equal(index.name, "Test registry");
  assert.equal(app.store.skills.list("local").length, 0, "browsing installs nothing");
  await assert.rejects(api("registry/install", { url, skillId: "tampered" }), /does not match the fingerprint/);
  await assert.rejects(api("registry/install", { url, skillId: "missing" }), /has no skill called missing/);
  const installed = await api("registry/install", { url, skillId: "helper" });
  assert.equal(installed.activeVersion, null, "installed but not active");
  assert.equal(installed.origin.registryName, "Test registry");
  assert.deepEqual(app.store.skills.catalog("local"), [], "not in the model's catalog until activated");
  const activated = app.store.skills.activate("local", installed.id, { version: 1, expectedRevision: installed.revision });
  assert.equal(activated.activeVersion, 1);
  assert.equal(app.store.skills.catalog("local")[0].name, "registry-helper");
});

test("the fixed evaluation suite records accuracy, latency and cost from real runs and marks energy unavailable", async (t) => {
  const steps = [say("391"), call("files.write", { path: "eval-note.txt", content: "ready" }), say("done"), say('{"city":"Lagos","population":15000000}')];
  const { app, api } = await fixture(t, steps);
  assert.equal(standardSuite.tasks.length, 3);
  const result = await api("evaluation", {});
  assert.deepEqual([result.summary.passed, result.summary.total, result.summary.accuracy], [3, 3, 1]);
  assert.equal(result.summary.energy, "unavailable");
  assert.ok(result.summary.latencyMs.mean >= 0 && result.summary.tokens > 0);
  assert.deepEqual(result.tasks.map((x) => [x.id, x.passed]), [["arithmetic", true], ["file-write", true], ["json-shape", true]]);
  assert.equal((await api("evaluation")).results.length, 1);
  const custom = await api("evaluation", { name: "Custom", tasks: [{ id: "one", prompt: "say the word banana", checks: { mustMention: ["banana"], maxRetries: 0 } }] });
  assert.equal(custom.summary.accuracy, 0, "the scripted provider never says banana");
  assert.match(custom.tasks[0].problem, /does not mention "banana"/);
  void app;
});
