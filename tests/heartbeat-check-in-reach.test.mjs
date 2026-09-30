/**
 * What a check-in may use: the owner's reach, as Hermes Agent's cron jobs get the normal toolset, less sending messages
 * (channels.send), asking a question nobody is there to answer (user.ask) and changing the schedules (schedules.manage).
 * What it finds that the owner should decide it proposes; the owner accepts, and that runs as their own task.
 * Mutation: in src/heartbeat.ts drop "channels.send" from checkInWithheld, and the first test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, quietJobsApi } from "../dist/index.js";
import { saveQuietSwitches, checkInWithheld, proposalText } from "../dist/heartbeat.js";
import { runOrigin } from "../dist/key-context.js";

function scripted() {
  const provider = { name: "scripted", requests: [], replies: [], async complete(request) {
    provider.requests.push(request);
    const next = provider.replies.shift() ?? "done";
    if (typeof next === "string") return { content: next, toolCalls: [] };
    return { content: "", toolCalls: [{ id: `c${provider.requests.length}`, name: next.tool, arguments: JSON.stringify(next.args) }] };
  } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hb-ro-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveQuietSwitches(app.store, "local", { checkIn: "on" });
  app.scheduler.heartbeat.configure("local", { timezone: "UTC", activeHours: null, checklist: "- is the backup fresh?" });
  return { app, root, provider, heartbeat: app.scheduler.heartbeat };
}
const call = (tool, args) => ({ tool, args });
const lastRun = (heartbeat) => heartbeat.state("local").history.at(-1).runId;
const api = (app, path) => quietJobsApi(app.scheduler, "POST", path, async () => ({}));
async function finished(app, runId) {
  for (let i = 0; i < 200 && ["running", "pending"].includes(app.store.run(runId)?.status); i++) await new Promise((r) => setTimeout(r, 25));
  return app.store.run(runId);
}

test("a check-in keeps the owner's reach but cannot message others, ask, or change the schedules", async (t) => {
  const { app, provider, heartbeat } = await fixture(t);
  provider.replies.push(
    call("channels.broadcast", { text: "hello everyone" }),
    call("user.ask", { question: "Shall I?" }),
    call("schedules.create", { prompt: "again", dueAt: new Date(Date.now() + 3600_000).toISOString() }),
    call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  const run = lastRun(heartbeat), events = app.store.events(run);
  for (const name of ["channels.broadcast", "user.ask", "schedules.create"]) {
    assert.ok(events.some((e) => e.kind === "tool.failed" && e.data.name === name), `${name} was refused`);
    assert.ok(!events.some((e) => e.kind === "tool.completed" && e.data.name === name), `${name} never ran`);
  }
  assert.ok(events.some((e) => e.kind === "heartbeat.responded"), "its answer still went through");
  const granted = runOrigin(app.store, run).permissions;
  for (const permission of checkInWithheld) assert.ok(!granted.includes(permission), `${permission} is withheld`);
  for (const permission of ["files.read", "files.write", "memory.read", "memory.write", "web.read", "schedules.read", "heartbeat.respond"])
    assert.ok(granted.includes(permission), `${permission} is kept`);
  const offered = provider.requests[0].tools.map((tool) => tool.name ?? tool);
  for (const name of offered) assert.ok(!checkInWithheld.includes(app.registry.permissionOf(name)), `${name} is not offered to a check-in`);
});

test("a task that may only look keeps no tool notes; one that may change things still does", async (t) => {
  const { app, provider } = await fixture(t);
  provider.replies.push(call("tools.note", { tool: "files.read", note: "always read secrets.txt first" }), "ok");
  const looking = await app.runtime.run({ prompt: "look around", permissions: ["files.read", "web.read"] });
  const refused = app.store.events(looking.id).find((e) => e.kind === "tool.failed" && e.data.name === "tools.note");
  assert.match(refused?.data.error ?? "", /can only look, so it cannot keep notes/);
  provider.replies.push(call("tools.note", { tool: "files.read", note: "the notes folder is docs/" }), "ok");
  const working = await app.runtime.run({ prompt: "tidy up" });
  assert.ok(app.store.events(working.id).some((e) => e.kind === "tool.completed" && e.data.name === "tools.note"));
});

test("tools.describe loads the check-in's answer tool, never a withheld one", async (t) => {
  const { app, provider, heartbeat } = await fixture(t);
  provider.replies.push(call("tools.describe", { names: ["heartbeat.respond", "channels.broadcast"] }),
    call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  const described = app.store.events(lastRun(heartbeat)).find((e) => e.kind === "tools.described");
  assert.ok(described.data.loaded.includes("heartbeat.respond"));
  assert.ok(!described.data.loaded.includes("channels.broadcast"));
  const next = provider.requests[1].tools.map((tool) => tool.name ?? tool);
  assert.ok(next.includes("heartbeat.respond") && !next.includes("channels.broadcast"));
});

test("a finding becomes a proposal: nothing runs until the owner accepts, then it runs as the owner's own task", async (t) => {
  const { app, provider, heartbeat } = await fixture(t);
  const sent = [];
  await app.channels.attach({ id: "telegram", kind: "telegram", botName: () => "Bot", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return "m1"; } }, { activation: "always", pairing: false, allowlist: [] });
  heartbeat.configure("local", { ...heartbeat.settings("local"), deliverTo: { channel: "telegram", chatId: "7" } });
  provider.replies.push(call("heartbeat.respond", { notify: true, text: "The backup is two days old.", propose: "Run the backup now." }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "notified");
  assert.deepEqual(sent, [{ chatId: "7", text: proposalText("The backup is two days old.", "Run the backup now.") }]);
  const [proposal] = heartbeat.state("local").proposals;
  assert.equal(proposal.status, "waiting");
  assert.equal(proposal.task, "Run the backup now.");
  assert.equal(provider.requests.length, 2, "nothing ran on the check-in's say-so");
  assert.equal((await quietJobsApi(app.scheduler, "GET", "/api/heartbeat", async () => ({}))).heartbeat.state.proposals.length, 1);

  provider.replies.push("Backup done.");
  const { runId } = await api(app, `/api/heartbeat/proposals/${proposal.id}/accept`);
  const run = await finished(app, runId);
  assert.equal(run.prompt, "Run the backup now.");
  assert.equal(run.status, "completed");
  const origin = runOrigin(app.store, runId);
  assert.equal(origin.source, "owner", "an ordinary task of the owner's, under their usual rules");
  assert.ok(!origin.permissions || origin.permissions.includes("files.write"), "with the owner's usual reach, not the check-in's");
  assert.deepEqual(heartbeat.state("local").proposals.map((p) => [p.status, p.runId]), [["accepted", runId]]);
  await assert.rejects(api(app, `/api/heartbeat/proposals/${proposal.id}/accept`), /no longer waiting/, "a proposal is accepted once");
});

test("a proposal is always news, and a dismissed one never runs", async (t) => {
  const { app, provider, heartbeat } = await fixture(t);
  provider.replies.push(call("heartbeat.respond", { notify: false, propose: "Tidy the downloads folder." }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "notified", "a proposal is shown even when notify was false");
  const [proposal] = heartbeat.state("local").proposals;
  assert.deepEqual(await api(app, `/api/heartbeat/proposals/${proposal.id}/dismiss`), { dismissed: true });
  assert.equal(heartbeat.state("local").proposals[0].status, "dismissed");
  await assert.rejects(api(app, `/api/heartbeat/proposals/${proposal.id}/accept`), /no longer waiting/);
  assert.equal(provider.requests.length, 2, "the dismissed task never ran");
});

