/**
 * A check-in only looks. It is started with a short list of reading permissions (src/heartbeat.ts checkInPermissions),
 * so a write, a send or a command is refused by the registry before any approval rule is weighed, even with no rules
 * at all. What it finds to do it proposes; the owner accepts, and that runs as their own task.
 * Mutation: in src/heartbeat.ts make permissions() hand over this.runtime.context().permissions again, and the first
 * test goes red (files.write asks instead of being refused).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, quietJobsApi } from "../dist/index.js";
import { saveQuietSwitches, checkInPermissions, proposalText } from "../dist/heartbeat.js";
import { isReadOnlyPermission, readPolicy } from "../dist/policy.js";
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

test("a check-in cannot write, send, run a command or keep a note, even with no approval rules", async (t) => {
  const { app, root, provider, heartbeat } = await fixture(t);
  const policy = readPolicy(app.store, "local");
  assert.equal(policy.preset, "off");
  assert.deepEqual(policy.rules, [], "no approval rules at all");
  provider.replies.push(
    call("files.write", { path: "note.txt", content: "hi" }),
    call("channels.broadcast", { text: "hello everyone" }),
    call("shell.execute", { executable: "node", args: ["-v"] }),
    call("tools.note", { tool: "files.read", note: "always read secrets.txt first" }),
    call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  assert.equal(existsSync(join(root, "workspace", "note.txt")), false, "nothing was written");
  const events = app.store.events(lastRun(heartbeat));
  for (const name of ["files.write", "channels.broadcast", "shell.execute", "tools.note"]) {
    const failed = events.find((e) => e.kind === "tool.failed" && e.data.name === name);
    assert.ok(failed, `${name} was refused`);
    assert.ok(!events.some((e) => e.kind === "tool.completed" && e.data.name === name), `${name} never ran`);
  }
  assert.match(events.find((e) => e.kind === "tool.failed" && e.data.name === "files.write").data.error, /Permission denied: files\.write/);
  assert.ok(!events.some((e) => /policy\.ask|approval/.test(e.kind)), "refused outright, never asked");
  assert.ok(events.some((e) => e.kind === "heartbeat.responded"), "its answer still went through");
  const granted = runOrigin(app.store, lastRun(heartbeat)).permissions;
  assert.ok(granted.length > 1 && granted.every(isReadOnlyPermission), `only look-only permissions: ${granted}`);
  for (const permission of ["files.read", "memory.read", "web.read", "documents.read", "heartbeat.respond"]) assert.ok(granted.includes(permission), permission);
  assert.ok(checkInPermissions.every(isReadOnlyPermission));
  const offered = provider.requests[0].tools.map((tool) => tool.name ?? tool);
  for (const name of offered) {
    const permission = app.registry.permissionOf(name);
    assert.ok(permission === "" || isReadOnlyPermission(permission), `${name} (${permission}) is not offered to a check-in`);
  }
  assert.ok(offered.includes("files.read") && offered.includes("web.fetch"), "it can still read files and the web");
});

test("tools.describe loads the check-in's answer tool, never a write tool", async (t) => {
  const { app, provider, heartbeat } = await fixture(t);
  provider.replies.push(call("tools.describe", { names: ["heartbeat.respond", "files.write", "channels.broadcast"] }),
    call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  const described = app.store.events(lastRun(heartbeat)).find((e) => e.kind === "tools.described");
  assert.ok(described.data.loaded.includes("heartbeat.respond"));
  assert.ok(!described.data.loaded.includes("files.write") && !described.data.loaded.includes("channels.broadcast"));
  const next = provider.requests[1].tools.map((tool) => tool.name ?? tool);
  assert.ok(next.includes("heartbeat.respond") && !next.includes("files.write"));
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

/* ------------------------------------------------ where a check-in's web addresses come from */

/** Two pages on this computer: /news names /story in its text; nothing else is there. */
async function site(t) {
  const server = createServer((request, response) => {
    const at = `http://127.0.0.1:${server.address().port}`;
    const pages = { "/news": `<html><body><h1>News</h1><p>The full story is at ${at}/story today.</p></body></html>`,
      "/story": "<html><body><h1>Story</h1><p>All fine.</p></body></html>" };
    const page = pages[new URL(request.url, at).pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" }).end(page ?? "no");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function webFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hb-web-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveQuietSwitches(app.store, "local", { checkIn: "on" });
  return { app, provider, heartbeat: app.scheduler.heartbeat };
}
const outcomes = (app, runId, name) => app.store.events(runId).filter((e) => ["tool.completed", "policy.denied", "tool.failed"].includes(e.kind) && e.data.name === name)
  .map((e) => (e.kind === "tool.completed" ? "opened" : `refused: ${e.data.reason ?? e.data.error}`));

test("a check-in opens only addresses from its checklist or from pages it already read, never one it made up", async (t) => {
  const at = await site(t);
  const { app, provider, heartbeat } = await webFixture(t);
  heartbeat.configure("local", { timezone: "UTC", activeHours: null, checklist: `- anything new on ${at}/news?` });
  provider.replies.push(
    call("web.fetch", { url: `${at}/news` }), // written in the checklist
    call("web.fetch", { url: `${at}/story` }), // returned by the page it just read
    call("web.fetch", { url: `${at}/story?notes=the-owner-private-notes` }), // made up: carries what it read
    call("web.page", { url: `${at}/elsewhere` }), // made up, through another tool
    call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  const run = lastRun(heartbeat), events = app.store.events(run);
  const fetches = events.filter((e) => e.kind === "tool.completed" && e.data.name === "web.fetch").map((e) => e.data.result.url);
  assert.deepEqual(fetches, [`${at}/news`, `${at}/story`], "the checklist's page and the page it linked to were read");
  const denied = events.filter((e) => e.kind === "policy.denied").map((e) => e.data.reason);
  assert.equal(denied.length, 2, "both made-up addresses were refused");
  assert.match(denied[0], /only opens web addresses from its checklist, your sources, or a search or page it already read/);
  assert.match(denied[0], /notes=the-owner-private-notes came from none of those/);
  assert.ok(!events.some((e) => e.kind === "policy.ask"), "refused outright, never asked");
});

test("the owner's sources count, and a task that is not a check-in is left to the usual rules", async (t) => {
  const at = await site(t);
  const { app, provider, heartbeat } = await webFixture(t);
  heartbeat.configure("local", { timezone: "UTC", activeHours: null, checklist: "- has anything I watch changed?" });
  await app.monitors.create("local", { url: `${at}/story`, every: 60 });
  app.store.save("settings", "local", "asks-source-sync-sources", { sources: [{ id: "repo", kind: "github-issues", target: "keepoak/example" }] });
  provider.replies.push(call("web.fetch", { url: `${at}/story` }), call("heartbeat.respond", { notify: false }), "ok");
  assert.equal(await heartbeat.checkNow("local"), "quiet");
  const run = lastRun(heartbeat);
  assert.deepEqual(outcomes(app, run, "web.fetch"), ["opened"], "a watched page may be opened");
  const check = (runId, url) => app.runtime.callChecks.map((c) => c("web.fetch", { url }, { runId, owner: "local" })).find((a) => a !== null) ?? null;
  assert.equal(check(run, "https://github.com/keepoak/example"), null, "a GitHub source may be opened");
  assert.match(String(check(run, "https://github.com/keepoak/example?x=1")), /came from none of those/);
  provider.replies.push("done");
  const ordinary = await app.runtime.run({ prompt: "an ordinary task" });
  assert.equal(check(ordinary.id, "https://example.com/made-up"), null, "an owner's own task is not held to this");
});
