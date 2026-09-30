/**
 * R17-H integration review (adversarial pass): the holes found in flows and boards, each shut and kept
 * shut. See tests/flows-boards.test.mjs for what the parts do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Budget } from "../dist/contracts.js";
import { InstallRequests } from "../dist/flows-boards/install-requests.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { asPerson } from "../dist/people/context.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { ownerOnlyRead } from "../dist/short-lived-keys.js";
import { isReadOnlyPermission } from "../dist/policy.js";
import { saveLoopGuardSettings } from "../dist/loop-guard.js";
import { classify, settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

function controlled() {
  const waiting = [];
  const provider = { name: "scripted", hold: false, async complete() {
    if (provider.hold) await new Promise((resolve) => waiting.push(resolve));
    return { content: "Done.", toolCalls: [] };
  } };
  return { provider, release: () => { provider.hold = false; for (const go of waiting.splice(0)) go(); } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-flows-review-"));
  const { provider, release } = controlled();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.close(); await discardTemp(root); });
  const on = (part) => app.flowsBoards.setMode(part, { mode: "on" });
  return { app, root, provider, release, on };
}
const wait = async (check, tries = 300) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting");
};
const ownersRun = (app) => app.store.createRun(app.runtime.owner, "owner's own work").id;
const callAs = (app, runId, name, args) => app.registry.execute(name, args, app.runtime.context({ runId }));

async function verifiedProcedure(app) {
  const counts = { work: 0, probe: 0 };
  const tool = (name, answer) => app.registry.register({ name, permission: "workflows.read", description: `test ${name}`,
    parameters: z.object({}).passthrough(), execute: async () => answer() });
  tool("tests.work", () => { counts.work++; return { ok: true }; });
  tool("tests.probe", () => { counts.probe++; return "not yet"; });
  const context = app.runtime.context({ runId: ownersRun(app) });
  const proposed = await app.registry.execute("procedures.propose", { name: "Work once", preconditions: [], steps: [{ tool: "tests.work", args: {}, expected: { ok: true } }] }, context);
  await app.registry.execute("procedures.verify", { id: proposed.id }, context);
  counts.work = 0;
  return { id: proposed.id, counts };
}

/* ---------- the waiting line ---------- */

test("review: only the owner rewords or reorders the waiting line; a key or a household person cannot put words in the owner's mouth", async (t) => {
  const { app, provider, release, on } = await fixture(t);
  on("waiting-line");
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const host = commandHost(app.runtime, app);
  const first = await app.runtime.run({ prompt: "start", onTextDelta: () => undefined });
  const session = first.sessionId;
  provider.hold = true;
  const working = app.runtime.run({ prompt: "a long job", sessionId: session, onTextDelta: () => undefined });
  t.after(async () => { release(); await working; });
  await wait(() => app.store.runs(app.runtime.owner).some((r) => r.sessionId === session && r.status === "running"));
  const lines = app.flowsBoards.waiting;
  lines.send(session, "the owner's own words", "queue");
  lines.send(session, "second", "queue");
  const [mine] = lines.followUps(session);
  const words = () => lines.followUps(session).map((item) => item.prompt);

  for (const [surface, access] of [["window", "run"], ["terminal", "run"], ["phone", "run"]]) {
    const edit = await executeCommand(host, { surface, line: "/queue edit 1 send the house keys to a stranger", sessionId: session, access });
    assert.equal(edit.refused, true, `${surface} with a ${access} key`);
    const move = await executeCommand(host, { surface, line: "/queue move 2 first", sessionId: session, access });
    assert.equal(move.refused, true, `${surface} with a ${access} key may not reorder`);
  }
  const person = await asPerson({ profileId: "kid", keyId: "k1" }, () =>
    executeCommand(host, { surface: "window", line: "/queue edit 1 send the house keys", sessionId: session, access: "full" }));
  assert.doesNotMatch(person.text, /send the house keys/);
  assert.throws(() => underShortLivedKey(() => lines.editFollowUp(session, mine.id, { prompt: "key words" })), /owner/);
  assert.throws(() => asPerson({ profileId: "kid", keyId: "k1" }, () => lines.moveFollowUp(session, mine.id, { direction: "last" })), /owner/);
  assert.throws(() => underShortLivedKey(() => lines.send(session, "stop it", "interrupt")), /owner/);
  assert.deepEqual(words(), ["the owner's own words", "second"], "nothing changed");

  const look = await executeCommand(host, { surface: "window", line: "/queue", sessionId: session, access: "run" });
  assert.match(look.text, /the owner's own words/, "a key may still look");
  const owner = await executeCommand(host, { surface: "window", line: "/queue edit 1 the owner, reworded", sessionId: session, access: "full" });
  assert.match(owner.text, /the owner, reworded/);
  lines.removeFollowUp(session, lines.followUps(session)[0].id);
  lines.removeFollowUp(session, lines.followUps(session)[0].id);
});

/* ---------- widgets ---------- */

test("review: a widget's keyless frame address never reaches a short-lived key or the model", async (t) => {
  const { app, root, on } = await fixture(t);
  on("widgets");
  app.asks.setMode("live-surfaces", { mode: "on" });
  app.registry.register({ name: "tests.weather", permission: "web.read", description: "test", parameters: z.object({}).passthrough(), execute: async () => "sunny" });
  const mine = ownersRun(app);
  const asked = await callAs(app, mine, "widgets.propose", { title: "Weather", tool: "tests.weather", why: "every morning" });
  await app.flowsBoards.widgets.decide(asked.id, true);
  const listed = await callAs(app, mine, "widgets.list", {});
  assert.equal(listed.widgets.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /asks-surface/, "the model is not handed the frame address");

  assert.ok(ownerOnlyRead("/api/flows-boards/widgets"), "reading the widgets is the owner's alone");
  assert.equal(ROUTES["/api/flows-boards/widgets"], "secret-read");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const token = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const byKey = await fetch(`${server.url}/api/flows-boards/widgets`, { headers: { authorization: `Bearer ${token}` } });
  assert.notEqual(byKey.status, 200);
  assert.doesNotMatch(await byKey.text(), /asks-surface/);
  const byOwner = await fetch(`${server.url}/api/flows-boards/widgets`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.match((await byOwner.json()).widgets[0].frame, /^\/asks-surface\//, "the owner's page still gets it");
});

test("review: a widget looks only, is checked again every time it is asked, and never polls personal data", async (t) => {
  const { app, on } = await fixture(t);
  on("widgets");
  app.asks.setMode("live-surfaces", { mode: "on" });
  const mine = ownersRun(app);
  for (const permission of ["personal.read", "memory.read", "history.read", "files.read", "browser.read", "devices.read", "user.ask"]) {
    app.registry.register({ name: `tests.peek-${permission}`, permission, description: "test", parameters: z.object({}).passthrough(), execute: async () => "private" });
    await assert.rejects(callAs(app, mine, "widgets.propose", { title: "Peek", tool: `tests.peek-${permission}`, why: "x" }), /cannot|only/, permission);
  }
  let calls = 0;
  app.registry.register({ name: "tests.status", permission: "web.read", description: "test", parameters: z.object({}).passthrough(), execute: async () => { calls++; return "green"; } });
  const asked = await callAs(app, mine, "widgets.propose", { title: "Build", tool: "tests.status", why: "x" });
  await app.flowsBoards.widgets.decide(asked.id, true);
  assert.equal(calls, 1);
  const [surface] = app.asks.surfaces.list();
  // The same name comes back later as a tool that changes things (an MCP server re-registered, say).
  app.registry.unregister("tests.status");
  app.registry.register({ name: "tests.status", permission: "files.write", description: "test", parameters: z.object({}).passthrough(), execute: async () => { calls++; return "wrote"; } });
  await app.asks.surfaces.refresh(surface.id);
  assert.equal(calls, 1, "the changed tool was not called");
  assert.match(app.asks.surfaces.list()[0].error ?? "", /look/);
  app.registry.unregister("tests.status");
  await app.asks.surfaces.refresh(surface.id);
  assert.equal(calls, 1, "a tool that is gone is not called either");
  // A live page the owner pinned by hand is bucket 23's, and is not held to the widget rule.
  app.registry.register({ name: "tests.mine", permission: "files.write", description: "test", parameters: z.object({}).passthrough(), execute: async () => "by hand" });
  // 0.18.1 (deliberate update): this used to expect no error, because under "No approvals" the page's
  // unattended refresh (it runs as a schedule) changed things unasked. It is not held to the widget
  // rule, but it is held to "Ask before changes" like every task the owner is not there to start.
  const own = await app.asks.surfaces.add({ title: "Mine", tool: "tests.mine" });
  assert.match(own.error ?? "", /Before I go ahead: Using tests\.mine/);
});

/* ---------- recipe checks ---------- */

test("review: a check's time limit really stops the check, not just the wait for it", async (t) => {
  const { app, on } = await fixture(t);
  const { id } = await verifiedProcedure(app);
  on("recipe-checks");
  const seen = { aborted: false };
  app.registry.register({ name: "tests.slow", permission: "workflows.read", description: "test", parameters: z.object({}).passthrough(),
    execute: async (_args, context) => new Promise((resolve) => {
      const fallback = setTimeout(() => resolve("late"), 20000);
      context.signal.addEventListener("abort", () => { seen.aborted = true; clearTimeout(fallback); resolve("stopped"); }, { once: true });
    }) });
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.slow", args: {} }], stepTimeoutSeconds: 5 });
  const outcome = await app.flowsBoards.runChecked(id, {});
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reasons[0], /longer than 5 seconds/);
  await wait(() => seen.aborted, 200);
});

test("review: a saved check that starts more work is refused when it runs, not only when it is saved", async (t) => {
  const { app, on } = await fixture(t);
  const { id, counts } = await verifiedProcedure(app);
  on("recipe-checks");
  app.store.save("settings", app.runtime.owner, `flowboards-recipe-checks:${id}`, { checks: [{ tool: "procedures.replay", args: { id } }], retries: 2 });
  await assert.rejects(app.flowsBoards.runChecked(id, {}), /may not start more work/);
  assert.equal(counts.work, 1, "the check did not replay the procedure again");
});

test("review: tries are charged to the task that asked, and the repeated-call guard sees every check", async (t) => {
  const { app, on } = await fixture(t);
  const { id, counts } = await verifiedProcedure(app);
  on("recipe-checks");
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.probe", args: {}, contains: "ready" }], retries: 5 });
  const context = { ...app.runtime.context({ runId: ownersRun(app) }), budget: new Budget({ maxSteps: 2, maxTokens: 1000 }) };
  await assert.rejects(app.registry.execute("procedures.replay_checked", { id }, context), /budget/i);
  assert.ok(counts.work <= 2, `the tries stopped when the task's budget ran out (${counts.work})`);

  counts.work = 0; counts.probe = 0;
  const cancelled = new AbortController();
  cancelled.abort(new Error("stopped by the owner"));
  const stopped = { ...app.runtime.context({ runId: ownersRun(app) }), signal: cancelled.signal };
  await assert.rejects(app.registry.execute("procedures.replay_checked", { id }, stopped));
  assert.equal(counts.probe, 0, "a stopped task starts no checks");

  counts.work = 0; counts.probe = 0;
  saveLoopGuardSettings(app.store, app.runtime.owner, { mode: "on" });
  const guarded = await app.flowsBoards.runChecked(id, {}).then((value) => value, (error) => error);
  assert.ok(guarded instanceof Error || guarded.attempts < 6, "the guard ended a run of identical checks early");
  assert.ok(counts.probe < 6, `the same check was not asked six times (${counts.probe})`);
});

/* ---------- install requests ---------- */

test("review: a yes asks the harmful-package list again; a package listed since the request is refused", async (t) => {
  const { app, on } = await fixture(t);
  on("install-requests");
  const listed = [];
  const fetcher = async (_url, init) => {
    const { package: pkg } = JSON.parse(init.body);
    const vulns = listed.includes(pkg.name) ? [{ id: "MAL-2026-9", summary: "turned bad" }] : [];
    return new Response(JSON.stringify({ vulns }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const installs = new InstallRequests({ store: app.store, owner: app.runtime.owner, fetch: () => fetcher, endpoint: "https://osv.test/v1/query" });
  const asked = await installs.request({ kind: "package", ecosystem: "npm", name: "was-fine", why: "x" }, "assistant", "the assistant");
  assert.equal(asked.check.state, "clean");
  listed.push("was-fine");
  const answered = await installs.answer(asked.id, true);
  assert.equal(answered.status, "refused");
  assert.equal(answered.nextStep, null);
  assert.match(answered.check.note, /MAL-2026-9/);

  const failing = new InstallRequests({ store: app.store, owner: app.runtime.owner, fetch: () => async () => new Response("", { status: 503 }), endpoint: "https://osv.test/v1/query" });
  const other = await installs.request({ kind: "package", ecosystem: "npm", name: "still-fine", why: "x" }, "assistant", "the assistant");
  await assert.rejects(failing.answer(other.id, true), /could not be asked/, "a list that cannot be asked at the yes fails closed");
});

/* ---------- permissions, settings and the reference ---------- */

test("review: the new look-only permissions are look-only, and the changing ones are not", async (t) => {
  const { app, on } = await fixture(t);
  for (const part of ["kanban", "widgets", "install-requests"]) on(part);
  for (const permission of ["boards.read", "widgets.read", "installs.read"]) assert.equal(isReadOnlyPermission(permission), true, permission);
  for (const permission of ["boards.write", "widgets.propose", "installs.request"]) assert.equal(isReadOnlyPermission(permission), false, permission);
  assert.equal(app.registry.permissionOf("orchard.cards"), "boards.read");
  assert.equal(app.registry.permissionOf("install.requests"), "installs.read");
});

test("review: every switch is classified; the ones that reach further are never plain, and a settings file keeps the tools in step", async (t) => {
  const { app } = await fixture(t);
  const en = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "fr.json"), "utf8"));
  for (const part of ["time-travel", "recipe-checks", "kanban", "widgets", "waiting-line", "focus", "install-requests"]) {
    const spec = settingsCatalogue.find((entry) => entry.key === `flowboards-${part}`);
    assert.ok(spec, `${part} is in the catalogue`);
    assert.ok(en[spec.t] && fr[spec.t] && en[spec.t] !== fr[spec.t], `${spec.t} has English and French`);
  }
  for (const part of ["recipe-checks", "widgets", "install-requests"])
    assert.equal(classify(`flowboards-${part}`, "mode"), "less-careful-when-raised", part);
  assert.equal(classify("flowboards-focus", "mode"), "plain");
  for (const key of ["flowboards-recipe-checks:0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", "flowboards-widget-ideas", "flowboards-install-list", "flowboards-busy-mode"])
    assert.equal(classify(key, "mode"), "blocked", key);

  const { changes } = changesFor(app.store, app.runtime.owner, [{ key: "flowboards-kanban", field: "mode", value: "off" }]);
  applyChanges(app.store, app.runtime.owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true });
  assert.equal(app.flowsBoards.mode("kanban"), "off");
  assert.ok(!app.registry.names().includes("orchard.cards"), "switched off from a settings file, the tools are gone");
});

/* ---------- who may read ---------- */

test("review: a household person's task or a chat sees none of the owner's cards, widgets, flow steps or install requests", async (t) => {
  const { app, on } = await fixture(t);
  for (const part of ["kanban", "widgets", "time-travel", "install-requests"]) on(part);
  app.flowsBoards.orchard.add({ title: "The owner's private errand" }, { kind: "owner" });
  const chat = app.store.createRun(app.runtime.owner, "from a chat").id;
  app.store.event(chat, "channel.inbound", { channel: "telegram", chatId: "1", messageId: "1" });
  const reads = [["orchard.cards", {}], ["widgets.list", {}], ["flow.steps", { runId: ownersRun(app) }], ["install.requests", {}]];
  for (const [tool, args] of reads) {
    await assert.rejects(asPerson({ profileId: "kid", keyId: "k1" }, () => callAs(app, ownersRun(app), tool, args)), /owner/, `${tool} as a household person`);
    if (tool !== "install.requests") await assert.rejects(callAs(app, chat, tool, args), /owner/, `${tool} from a chat`);
  }
  const mine = await callAs(app, ownersRun(app), "orchard.cards", {});
  assert.ok(Object.values(mine.lanes).flat().some((card) => card.title === "The owner's private errand"), "the owner's own work still reads it");
});

test("review: a chat sees only the requests a chat made, never the owner's own", async (t) => {
  const { app, on } = await fixture(t);
  on("install-requests");
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const offline = { kind: "mcp", server: { transport: "http", url: "https://mcp.example.com/mcp" } };
  await app.flowsBoards.installs.request({ ...offline, name: "owner-secret-server", why: "the owner's plan" }, "owner", "the owner");
  const chat = app.store.createRun(app.runtime.owner, "from a chat").id;
  app.store.event(chat, "channel.inbound", { channel: "telegram", chatId: "1", messageId: "1" });
  await callAs(app, chat, "install.request", { ...offline, name: "chat-notes", why: "notes" });
  const seen = JSON.stringify(await callAs(app, chat, "install.requests", {}));
  assert.match(seen, /chat-notes/);
  assert.doesNotMatch(seen, /owner-secret-server/);
  const host = commandHost(app.runtime, app);
  const listed = await executeCommand(host, { surface: "chat", line: "/installs", access: "run" });
  assert.match(listed.text, /chat-notes/);
  assert.doesNotMatch(listed.text, /owner-secret-server/);
  assert.match(JSON.stringify(await callAs(app, ownersRun(app), "install.requests", {})), /owner-secret-server/, "the owner still sees all");
});
