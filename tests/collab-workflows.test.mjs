import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, shareHtml, redactText, dayOffDecision, inQuietHours, quietUntil,
  weeklyReviewWorkflow, RedactionSchema, savePolicy, readPolicy,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted() {
  const provider = { name: "scripted", requests: [], failNext: false, hold: null, async complete(request) {
    provider.requests.push(request);
    if (provider.hold) await provider.hold;
    if (provider.failNext) { provider.failNext = false; throw new Error("provider down"); }
    return { content: `Result ${provider.requests.length}`, toolCalls: [] };
  } };
  return provider;
}
const discard = (base) => discardTemp(base).catch(() => undefined);
/** One app on its own data folder. Everything is closed before the folder goes, in that order. */
async function fixture(t, root) {
  const base = root ?? await mkdtemp(join(tmpdir(), "branch-collab-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about shared workflows, not reading first
  t.after(async () => {
    await app.close().catch(() => undefined);
    if (!root) await discard(base);
  });
  return { app, base, provider };
}
async function served(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-collab-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  const server = await startServer(app, { dataDir: join(base, "data"), port: 0 });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discard(base);
  });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body === undefined
      ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, provider, server, headers, call };
}
const planted = "Here is the key sk-proj-abcdefghijklmnopqrstuvwx1234 for the deploy and my address ada@example.com.";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out

/* ---- W1: a conversation as a page that can do nothing, with a receipt ---- */

test("the shared page carries no scripts and blanks out a planted key", async (t) => {
  const { app } = await fixture(t);
  const run = await app.runtime.run({ prompt: planted });
  const { html, receipt } = shareHtml({ sessionId: run.sessionId, title: "A chat" }, app.store.messages(run.sessionId));
  assert.ok(!/<script/i.test(html), "the page must carry no scripts at all");
  assert.ok(!/ on[a-z]+=/i.test(html), "the page must carry no inline handlers");
  assert.ok(!html.includes("sk-proj-abcdefghijklmnopqrstuvwx1234"), "the planted key must not survive");  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  assert.ok(html.includes("[removed before sharing]"));
  assert.equal(receipt.secretsRemoved, 1);
  assert.equal(receipt.contactDetailsRemoved, 0, "contact details stay unless the owner asks");
  assert.ok(receipt.messagesShared >= 1 && receipt.sessionId === run.sessionId);
  const withContacts = shareHtml({ sessionId: run.sessionId }, app.store.messages(run.sessionId),
    RedactionSchema.parse({ contactDetails: true }));
  assert.ok(!withContacts.html.includes("ada@example.com"));
  assert.equal(withContacts.receipt.contactDetailsRemoved >= 1, true);
});

test("the redaction pass leaves ordinary words alone", () => {
  const plain = redactText("We met on Tuesday and agreed the plan.", RedactionSchema.parse({ contactDetails: true }));
  assert.equal(plain.text, "We met on Tuesday and agreed the plan.");
  assert.equal(plain.secrets + plain.contactDetails, 0);
});

test("a share link needs its code, works once, and expires", async (t) => {
  const { app, server, call } = await served(t);
  const run = await app.runtime.run({ prompt: planted });
  const made = await call(`/api/sessions/${run.sessionId}/share`, { title: "Shared", expiresInMinutes: 60 });
  assert.equal(made.status, 200);
  assert.match(made.body.code, /^[0-9A-F]{6}$/);
  assert.equal(made.body.receipt.secretsRemoved, 1);
  const noCode = await fetch(server.url + made.body.path);
  assert.equal(noCode.status, 403, "a link without the code gives nothing away");
  const wrong = await fetch(`${server.url}${made.body.path}?code=ABCDEF`);
  assert.equal(wrong.status, 403);
  const right = await fetch(`${server.url}${made.body.path}?code=${made.body.code}`);
  assert.equal(right.status, 200);
  const page = await right.text();
  assert.ok(!/<script/i.test(page) && !page.includes("sk-proj-abcdefghijklmnopqrstuvwx1234"));  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const again = await fetch(`${server.url}${made.body.path}?code=${made.body.code}`);
  assert.equal(again.status, 403, "the code works once");
  // mac7/channel-leaks: the page says one thing for all five reasons. This address answers before
  // any key, so "already used" and "no such link" told a caller apart who had a real link from one
  // who was guessing. The reasons are still there underneath, for the owner's own screens.
  const oneSentence = await again.text();
  assert.deepEqual(oneSentence, await noCode.text());
  assert.equal(oneSentence.includes("already been used"), false);
  assert.throws(() => app.store.shares.open(made.body.id, made.body.code), /already been used once/);
  const expired = app.store.shares.create("local", { sessionId: run.sessionId, expiresInMinutes: 5 }, []);
  app.store.shares.now = () => new Date(Date.now() + 6 * 60000);
  assert.throws(() => app.store.shares.open(expired.id, expired.code), /expired/);
});

test("the HTML download hands back a receipt of what was shared", async (t) => {
  const { app, server, headers } = await served(t);
  const run = await app.runtime.run({ prompt: planted });
  const response = await fetch(`${server.url}/api/sessions/${run.sessionId}/export?format=html`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  const receipt = JSON.parse(response.headers.get("x-branch-share-receipt") ?? "{}");
  assert.equal(receipt.secretsRemoved, 1);
  assert.ok(!(await response.text()).includes("sk-proj-abcdefghijklmnopqrstuvwx1234"));  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
});

/* ---- W2: labels and project notes ---- */

test("labels filter the conversation search and notes stay with their project", async (t) => {
  const { app, call } = await served(t);
  const taxes = await app.runtime.run({ prompt: "what do I owe" });
  const other = await app.runtime.run({ prompt: "book a table" });
  await call("/api/labels", { target: "conversation", targetId: taxes.sessionId, label: "Money" });
  await call("/api/labels", { target: "conversation", targetId: taxes.sessionId, label: "urgent" });
  await call("/api/labels", { target: "conversation", targetId: other.sessionId, label: "money" });
  const both = await call("/api/sessions/search", { query: "", labels: ["money", "urgent"] });
  assert.deepEqual(both.body.sessions.map((s) => s.sessionId), [taxes.sessionId], "every label must match");
  const money = await call("/api/sessions/search", { query: "", labels: ["money"] });
  assert.equal(money.body.sessions.length, 2, "labels are matched however they were typed");
  const unlabelled = await call("/api/sessions/search", { query: "" });
  assert.equal(unlabelled.body.sessions.length, 2, "no labels means no filter");
  const catalog = await call("/api/labels");
  assert.deepEqual(catalog.body.catalog, [{ label: "money", count: 2 }, { label: "urgent", count: 1 }]);
  const gone = await call("/api/labels/remove", { target: "conversation", targetId: other.sessionId, label: "money" });
  assert.equal(gone.body.removed, true);
  assert.equal((await call("/api/sessions/search", { query: "", labels: ["money"] })).body.sessions.length, 1);
  const note = await call("/api/projects/notes", { project: "default", body: "Keep receipts for this one" });
  assert.ok(note.body.createdAt && note.body.id);
  const listed = await call("/api/projects/notes?project=default");
  assert.deepEqual(listed.body.notes.map((n) => n.body), ["Keep receipts for this one"]);
  assert.deepEqual((await call("/api/projects/notes?project=other")).body.notes, []);
});

test("labels and notes travel with the backup", async (t) => {
  const { app, call } = await served(t);
  const run = await app.runtime.run({ prompt: "keep this" });
  await call("/api/labels", { target: "conversation", targetId: run.sessionId, label: "keep" });
  await call("/api/projects/notes", { project: "default", body: "a note" });
  const backup = app.store.backup("test");
  assert.equal(backup.tables.labels.length, 1);
  assert.equal(backup.tables.project_notes.length, 1);
});

/* ---- W3: durable workflows ---- */

test("a workflow waits for approval, survives a restart, and carries on", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-collab-restart-"));
  t.after(() => discardTemp(root).catch(() => undefined));
  const first = await fixture(t, root);
  const made = first.app.workflows.create("local", {
    name: "Two halves", steps: [
      { name: "Look into it", kind: "prompt", prompt: "look into it" },
      { name: "Ask me first", kind: "approval", question: "Send it?" },
      { name: "Send it", kind: "prompt", prompt: "send it" },
    ],
  });
  const waiting = await first.app.workflows.run("local", made.id);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.question, "Send it?");
  assert.equal(waiting.cursor, 1);
  assert.equal(waiting.state[0].status, "done");
  await first.app.close();

  const second = await fixture(t, root);
  const reopened = second.app.workflows.view("local", made.id);
  assert.equal(reopened.status, "waiting_approval", "the workflow is exactly where it stopped");
  assert.equal(reopened.state[0].output, "Result 1", "what the first step produced was kept");
  const finished = await second.app.workflows.resume("local", made.id);
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.state.map((s) => s.status), ["done", "approved", "done"]);
});

test("a failing step is tried again, and gives up plainly when it keeps failing", async (t) => {
  const { app, provider } = await fixture(t);
  const retried = app.workflows.create("local", {
    name: "Flaky", steps: [{ name: "Try", kind: "prompt", prompt: "try", retries: 1 }],
  });
  provider.failNext = true;
  const done = await app.workflows.run("local", retried.id);
  assert.equal(done.status, "completed");
  assert.equal(done.state[0].attempts, 2, "the step was tried a second time");
  const doomed = app.workflows.create("local", {
    name: "Broken", steps: [{ name: "Use a tool", kind: "tool", tool: "no.such.tool", args: {} }],
  });
  const failed = await app.workflows.run("local", doomed.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Unknown tool/);
  assert.equal(failed.state[0].status, "failed");
});

test("a branch step skips ahead when the last answer did not say what was expected", async (t) => {
  const { app } = await fixture(t);
  const made = app.workflows.create("local", {
    name: "Only if needed", steps: [
      { name: "Check", kind: "prompt", prompt: "check" },
      { name: "Go on when it matched", kind: "branch", contains: "never appears", skipAhead: 2 },
      { name: "Skipped", kind: "prompt", prompt: "skipped" },
      { name: "Also skipped", kind: "prompt", prompt: "also skipped" },
    ],
  });
  const done = await app.workflows.run("local", made.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.state.map((s) => s.name), ["Check", "Go on when it matched"]);
});

test("every wait step waits its own turn, not only the first", async (t) => {
  const { app } = await fixture(t);
  const made = app.workflows.create("local", {
    name: "Twice over", steps: [
      { name: "Wait a moment", kind: "wait", waitMinutes: 0 },
      { name: "Do it", kind: "prompt", prompt: "do it" },
      { name: "Wait an hour", kind: "wait", waitMinutes: 60 },
      { name: "Do it again", kind: "prompt", prompt: "again" },
    ],
  });
  const held = await app.workflows.run("local", made.id);
  assert.equal(held.status, "waiting_time", "the second wait must hold, even though the first is over");
  assert.equal(held.cursor, 2);
  assert.ok(held.waitingUntil > new Date().toISOString());
  assert.deepEqual(held.state.map((step) => step.status), ["done", "done", "waiting"]);
});

test("the weekly review ships ready to save and run", async (t) => {
  const { app } = await fixture(t);
  const example = weeklyReviewWorkflow();
  assert.equal(example.name, "Weekly review");
  const saved = app.workflows.create("local", example);
  assert.equal(saved.steps.length, 3);
  const done = await app.workflows.run("local", saved.id);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(app.store.list("memory", "local").length, 1, "the review was kept in memory");
});

test("a paused workflow does not move until it is carried on", async (t) => {
  const { app } = await fixture(t);
  const made = app.workflows.create("local", {
    name: "Slow", steps: [
      { name: "One", kind: "prompt", prompt: "one" },
      { name: "Hold", kind: "approval" },
      { name: "Two", kind: "prompt", prompt: "two" },
    ],
  });
  await app.workflows.run("local", made.id);
  const paused = app.workflows.pause("local", made.id);
  assert.equal(paused.status, "paused");
  const carried = await app.workflows.resume("local", made.id);
  assert.equal(carried.status, "completed");
});

/* ---- W3b: a workflow's steps go through the approval settings ---- */

/** One workflow whose only step keeps a note, which counts as a change to the settings. */
const keepsANote = (app, name = "Keeps a note") => app.workflows.create("local", {
  name, steps: [{ name: "Keep it", kind: "tool", tool: "memory.put", args: { text: "from a step", source: "a workflow" } }],
});

test("a tool step stops for the owner under an ask rule and runs once they say yes", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, "local", { rules: [{ tool: "memory.put", decision: "ask" }] });
  const made = keepsANote(app);
  const stopped = await app.workflows.run("local", made.id);
  assert.equal(stopped.status, "waiting_approval", "the step may not use the tool without a yes");
  assert.match(stopped.question, /Before I go ahead/);
  assert.equal(app.store.list("memory", "local").length, 0, "nothing was done while it waits");
  await assert.rejects(
    () => app.runtime.executeTool("workflows.resume", { id: made.id }),
    /waiting for the owner/,
    "the assistant cannot say yes to the question its own step raised",
  );
  assert.equal(app.workflows.view("local", made.id).status, "waiting_approval");
  const carried = await call(`/api/workflows/${made.id}/resume`, {});
  assert.equal(carried.body.status, "completed", carried.body.error ?? "");
  assert.equal(app.store.list("memory", "local").length, 1, "the step ran, rather than being skipped");
  assert.equal(carried.body.state[0].status, "done");
  const decided = app.store.audit.list("local", {}).filter((row) => row.action === "approval.decided");
  assert.equal(decided.length, 1, "the yes is written into the record of what was allowed");
  assert.equal(decided[0].outcome, "allowed");
});

test("a tool step is refused in plain words under a deny rule", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { rules: [{ tool: "memory.put", decision: "deny" }] });
  const failed = await app.workflows.run("local", keepsANote(app, "Not allowed").id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Your settings do not allow this/);
  assert.equal(app.store.list("memory", "local").length, 0);
});

test("a standing yes lets a tool step run, and a workflow started by another app is still held back", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { rules: [
    { tool: "memory.put", match: "*", decision: "allow", remember: "always" },
    { tool: "*", applies: "changes", decision: "ask" },
  ] });
  const made = keepsANote(app, "Allowed for good");
  assert.equal((await app.workflows.run("local", made.id)).status, "completed");
  assert.equal(app.store.list("memory", "local").length, 1);
  const again = keepsANote(app, "Set going by another app");
  const held = await app.workflows.run("local", again.id, "mcp");
  assert.equal(held.status, "waiting_approval",
    "a standing yes does not carry over to a workflow another app set going");
});

test("the owner's yes can be kept as a standing rule, and one workflow's yes stays its own", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, "local", { rules: [{ tool: "memory.put", decision: "ask" }] });
  const first = keepsANote(app, "First");
  await app.workflows.run("local", first.id);
  const carried = await call(`/api/workflows/${first.id}/resume`, { remember: "always" });
  assert.equal(carried.body.status, "completed");
  assert.deepEqual(readPolicy(app.store, "local").rules[0],
    { tool: "memory.put", match: "*", applies: "any", decision: "allow", remember: "always" });
  const second = keepsANote(app, "Second");
  assert.equal((await app.workflows.run("local", second.id)).status, "completed",
    "the standing rule covers the next workflow too");
});

test("a yes remembered for one workflow only does not cover the next one", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, "local", { rules: [{ tool: "memory.put", decision: "ask" }] });
  const first = keepsANote(app, "Just this one");
  await app.workflows.run("local", first.id);
  await call(`/api/workflows/${first.id}/resume`, { remember: "session" });
  assert.equal(readPolicy(app.store, "local").rules.length, 1, "nothing standing was written");
  const second = keepsANote(app, "A different one");
  assert.equal((await app.workflows.run("local", second.id)).status, "waiting_approval");
});

test("a replayed recipe's own steps are checked, and nothing runs until the owner says yes", async (t) => {
  const { app, call } = await served(t);
  // read-first ships on (Q250). This test is about approval: verifying already wrote out.txt, so the replay's write would
  // be refused as unread. Whether a replayed recipe should be held to read-first is an open question (NOTES Q252).
  app.coding.setMode("read-first", "off");
  const context = app.runtime.context();
  const recipe = app.knowledge.proposeProcedure(context, {
    name: "write a file", preconditions: [],
    steps: [{ tool: "files.write", args: { path: "out.txt", content: "hello" }, expected: { path: "out.txt", bytes: 5 } }],
  });
  assert.equal((await app.knowledge.verifyProcedure(context, recipe.id)).data.status, "verified");
  savePolicy(app.store, "local", { rules: [{ tool: "files.write", decision: "ask" }] });
  const made = app.workflows.create("local", {
    name: "Replay it", steps: [{ name: "Replay", kind: "recipe", recipeId: recipe.id }],
  });
  const stopped = await app.workflows.run("local", made.id);
  assert.equal(stopped.status, "waiting_approval", "the step inside the recipe is checked too");
  assert.match(stopped.question, /out\.txt/);
  await assert.rejects(() => app.runtime.executeTool("workflows.resume", { id: made.id }), /waiting for the owner/);
  const carried = await call(`/api/workflows/${made.id}/resume`, {});
  assert.equal(carried.body.status, "completed", carried.body.error ?? "");
});

/* ---- W4: the waiting line ---- */

test("tasks join a waiting line in order of who asked, and a queued one can be taken out", async (t) => {
  const { app, provider, call } = await served(t);
  let release;
  provider.hold = new Promise((resolve) => { release = resolve; });
  await call("/api/queue/settings", { atOnce: 1 });
  const working = await call("/api/queue", { prompt: "first", source: "owner" });
  assert.equal(working.body.status, "running");
  const automatic = await call("/api/queue", { prompt: "from a schedule", source: "schedule" });
  const mine = await call("/api/queue", { prompt: "mine", source: "owner" });
  assert.equal(automatic.body.status, "waiting");
  const line = await call("/api/queue");
  assert.deepEqual(line.body.waiting.map((entry) => entry.prompt), ["first", "mine", "from a schedule"],
    "what the owner asks for goes in front of anything automatic");
  assert.deepEqual(line.body.waiting.map((entry) => entry.position), [1, 2, 3]);
  const cancelled = await call(`/api/queue/${automatic.body.id}/cancel`, {});
  assert.deepEqual(cancelled.body, { cancelled: true, wasRunning: false });
  assert.equal((await call("/api/queue")).body.waiting.length, 2);
  release();
  provider.hold = null;
  for (let i = 0; i < 100 && (await call("/api/queue")).body.waiting.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await call("/api/queue");
  assert.equal(after.body.waiting.length, 0, "the line empties once there is room");
  assert.deepEqual(after.body.recent.filter((e) => e.status === "done").map((e) => e.prompt).sort(), ["first", "mine"]);
});

test("the waiting line and the app's own screen share one count of what is working", async (t) => {
  const { app, provider } = await served(t);
  const limit = app.executions.limit;
  let release;
  provider.hold = new Promise((resolve) => { release = resolve; });
  app.runQueue.configure("local", { atOnce: 8 });
  // Three things are already working from the app's own screen: those places are taken.
  const fromTheScreen = [app.executions.take(), app.executions.take(), app.executions.take()];
  assert.ok(fromTheScreen.every(Boolean));
  for (let i = 0; i < 10; i++) app.runQueue.submit("local", { prompt: `task ${i}`, source: "owner" });
  const working = app.runQueue.list("local").filter((entry) => entry.status === "running");
  assert.equal(app.executions.count, limit, "the two together stop exactly at the limit");
  assert.equal(working.length, limit - fromTheScreen.length, "the line only started what was left over");
  assert.ok(app.runQueue.list("local").some((entry) => entry.status === "waiting"), "the rest wait their turn");
  release();
  provider.hold = null;
  for (const give of fromTheScreen) give();
  for (let i = 0; i < 200 && app.runQueue.list("local").length; i++) {
    assert.ok(app.executions.count <= limit, `never more than ${limit} at once`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(app.runQueue.list("local").length, 0, "the line empties once there is room");
  assert.equal(app.executions.count, 0, "every place is given back");
});

test("a queued task starts by itself as soon as a place comes back", async (t) => {
  const { app } = await served(t);
  const held = [];
  for (let i = 0; i < app.executions.limit; i++) held.push(app.executions.take());
  assert.ok(held.every(Boolean), "every place is taken by something else");
  const waiting = app.runQueue.submit("local", { prompt: "waits for room", source: "owner" });
  assert.equal(waiting.status, "waiting", "there is no room for it yet");
  for (const give of held) give();
  for (let i = 0; i < 200 && app.runQueue.entry("local", waiting.id).status === "waiting"; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(app.runQueue.entry("local", waiting.id).status, "waiting",
    "nobody had to add another task for the line to move");
});

test("a task already working is cancelled rather than simply dropped", async (t) => {
  const { app, provider, call } = await served(t);
  let release;
  provider.hold = new Promise((resolve) => { release = resolve; });
  const working = await call("/api/queue", { prompt: "long one" });
  assert.equal(working.body.status, "running");
  for (let i = 0; i < 100 && !app.runQueue.entry("local", working.body.id).runId; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = await call(`/api/queue/${working.body.id}/cancel`, {});
  assert.equal(cancelled.body.wasRunning, true);
  release();
  provider.hold = null;
});

/* ---- W5: days off and quiet hours ---- */

test("a schedule can skip a holiday or move to the next working day", () => {
  const settings = { country: "GB", daysOff: ["2026-07-06"], workingDays: [1, 2, 3, 4, 5], timezone: "UTC",
    quietHours: { enabled: false, from: "21:00", to: "07:00", timezone: "UTC" } };
  const holidays = { "2026-12-25": "Christmas Day" };
  const christmas = new Date("2026-12-25T09:00:00.000Z");
  assert.deepEqual(dayOffDecision(christmas, "run", settings, holidays), { action: "run", reason: null });
  assert.equal(dayOffDecision(christmas, "skip", settings, holidays).reason, "Christmas Day");
  const shifted = dayOffDecision(christmas, "shift", settings, holidays);
  assert.equal(shifted.action, "shift");
  assert.equal(shifted.moveTo.slice(0, 10), "2026-12-28", "Friday is a holiday and the weekend is not worked");
  const saturday = new Date("2026-07-04T09:00:00.000Z");
  assert.equal(dayOffDecision(saturday, "skip", settings, holidays).reason, "not one of your working days");
  const ownDayOff = new Date("2026-07-06T09:00:00.000Z");
  assert.equal(dayOffDecision(ownDayOff, "skip", settings, holidays).reason, "a day you marked off");
  const workday = new Date("2026-07-07T09:00:00.000Z");
  assert.deepEqual(dayOffDecision(workday, "shift", settings, holidays), { action: "run", reason: null });
});

test("a due schedule set to skip does not run on a day off", async (t) => {
  const { app } = await fixture(t);
  app.calendar.configure("local", { country: "GB", workingDays: [1, 2, 3, 4, 5], timezone: "UTC" });
  const context = app.runtime.context();
  const skipped = app.scheduler.create(context, { prompt: "daily note", dueAt: "2026-12-25T09:00:00.000Z",
    kind: "task", intervalMs: 86400000, daysOff: "skip" });
  const always = app.scheduler.create(context, { prompt: "always", dueAt: "2026-12-25T09:00:00.000Z",
    kind: "task", intervalMs: 86400000 });
  const runs = await app.scheduler.tick(new Date("2026-12-25T09:30:00.000Z"));
  assert.equal(runs.length, 1, "only the one that does not mind days off ran");
  const held = app.store.get("schedules", "local", skipped.id).data;
  assert.equal(held.lastDayOff.action, "skip");
  assert.equal(held.lastDayOff.reason, "Christmas Day");
  assert.equal(held.status, "pending");
  assert.ok(held.dueAt > "2026-12-25T09:30:00.000Z", "it waits for its next turn instead");
  assert.equal(app.store.get("schedules", "local", always.id).data.runCount, 1);
});

test("quiet hours run past midnight and say when they end", () => {
  const quiet = { enabled: true, from: "21:00", to: "07:00", timezone: "UTC" };
  assert.equal(inQuietHours(new Date("2026-05-01T22:30:00.000Z"), quiet), true);
  assert.equal(inQuietHours(new Date("2026-05-01T03:00:00.000Z"), quiet), true);
  assert.equal(inQuietHours(new Date("2026-05-01T12:00:00.000Z"), quiet), false);
  assert.equal(quietUntil(new Date("2026-05-01T12:00:00.000Z"), quiet), null);
  assert.equal(quietUntil(new Date("2026-05-01T22:30:00.000Z"), quiet), "2026-05-02T07:00:00.000Z");
  assert.equal(inQuietHours(new Date("2026-05-01T22:30:00.000Z"), { ...quiet, enabled: false }), false);
});

test("messages made during quiet hours wait until the morning", async (t) => {
  const { app } = await fixture(t);
  app.calendar.configure("local", { timezone: "UTC", quietHours: { enabled: true, from: "21:00", to: "07:00", timezone: "UTC" } });
  const night = new Date("2026-05-01T23:00:00.000Z");
  app.channels.deliveries.now = () => night;
  const held = app.channels.deliveries.enqueue("telegram", "7", "goodnight", "quiet:1");
  assert.equal(held[0].nextAt, "2026-05-02T07:00:00.000Z");
  const channel = { sent: [], async send(chatId, text) { channel.sent.push({ chatId, text }); return "m1"; } };
  assert.deepEqual(await app.channels.deliveries.flush("telegram", channel.send), { sent: 0, failed: 0, dead: 0 });
  assert.deepEqual(channel.sent, [], "nothing arrives in the night");
  app.channels.deliveries.now = () => new Date("2026-05-02T08:00:00.000Z");
  assert.equal((await app.channels.deliveries.flush("telegram", channel.send)).sent, 1);
  assert.deepEqual(channel.sent, [{ chatId: "7", text: "goodnight" }]);
});

test("the bundled holiday list is there and the owner gets an editable copy", async (t) => {
  const { app } = await fixture(t);
  const countries = app.calendar.countries();
  assert.ok(countries.length >= 3, "a few countries ship with the app");
  assert.ok(countries.every((country) => country.days > 0 && country.name));
  app.calendar.configure("local", { country: "US" });
  assert.equal(app.calendar.holidays("local")["2026-07-03"], "Independence Day (observed)");
});

/* ---- W6: profiles for a household ---- */

test("a second person's profile keeps their records apart and is refused the owner's secrets", async (t) => {
  const { app, call, server, headers } = await served(t);
  const ownersFact = await call("/api/memory/import", { jsonl: JSON.stringify({ id: "owner-1",
    data: { text: "The boiler code is on the fridge", source: "owner" } }) });
  assert.equal(ownersFact.body.imported, 1);
  const ownersChat = await app.runtime.run({ prompt: "owner's own conversation" });
  const made = await call("/api/profiles", { name: "Sam", pin: "4321" });
  assert.ok(made.body.id);
  const wrongPin = await call("/api/profiles/switch", { profileId: made.body.id, pin: "0000" });
  assert.equal(wrongPin.status, 400);
  assert.match(wrongPin.body.error, /PIN is not right/);
  const switched = await call("/api/profiles/switch", { profileId: made.body.id, pin: "4321" });
  assert.equal(switched.body.active.name, "Sam");
  assert.equal(switched.body.scope, `profile:${made.body.id}`);

  const state = await call("/api/state");
  assert.deepEqual(state.body.memory, [], "the owner's saved facts are not Sam's to read");
  assert.deepEqual(state.body.runs, [], "nor are the owner's conversations");
  assert.equal((await call("/api/sessions/search", { query: "" })).body.sessions.length, 0);
  assert.equal((await call(`/api/sessions/${ownersChat.sessionId}`)).status, 400);
  const secrets = await fetch(`${server.url}/api/secrets/default`, { headers });
  assert.equal(secrets.status, 400);
  assert.match((await secrets.json()).error, /belongs to the owner/);
  assert.match((await call("/api/projects")).body.error, /belongs to the owner/);

  const samsRun = await call("/api/run", { prompt: "Sam's own question" });
  assert.equal(samsRun.status, 200);
  assert.equal(app.store.ownsSession(`profile:${made.body.id}`, samsRun.body.sessionId), true);
  assert.equal(app.store.ownsSession("local", samsRun.body.sessionId), false);
  const samsState = await call("/api/state");
  assert.deepEqual(samsState.body.runs.map((run) => run.prompt), ["Sam's own question"]);
  assert.equal((await call(`/api/runs/${samsRun.body.id}`)).status, 200, "Sam can open her own task");
  assert.equal((await call(`/api/runs/${ownersChat.id}`)).status, 404, "but not the owner's");

  const back = await call("/api/profiles/switch", { profileId: null });
  assert.equal(back.body.active, null);
  const ownerState = await call("/api/state");
  assert.equal(ownerState.body.memory.length, 1, "the owner's facts are still the owner's");
  assert.deepEqual(ownerState.body.runs.map((run) => run.prompt), ["owner's own conversation"]);
  assert.equal((await fetch(`${server.url}/api/secrets/default`, { headers })).status, 200);
});

test("a profile cannot be added or removed by anyone but the owner", async (t) => {
  const { call } = await served(t);
  const made = await call("/api/profiles", { name: "Kit", pin: "1234" });
  await call("/api/profiles/switch", { profileId: made.body.id, pin: "1234" });
  const blocked = await call("/api/profiles", { name: "Another", pin: "1111" });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /belongs to the owner/);
  assert.match((await call(`/api/profiles/${made.body.id}/remove`, {})).body.error, /belongs to the owner/);
  await call("/api/profiles/switch", { profileId: null });
  assert.equal((await call(`/api/profiles/${made.body.id}/remove`, {})).body.removed, true);
});

/* ---- Integration review: proving the things the brief asked for, not only claiming them ---- */

test("chat-app tokens, secret-looking names in a tool result, and contact details are blanked out", async (t) => {
  const { app } = await fixture(t);
  const telegram = "110201874:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const run = await app.runtime.run({
    prompt: `My bot token is ${telegram} and my key is sk-proj-abcdefghijklmnopqrstuvwx1234.`,  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  });
  app.store.message(run.sessionId, { role: "tool", content:
    "TELEGRAM_BOT_TOKEN=7d9f1a2b3c4d5e6f7a8b9c0d\nwrite to ada@example.com or ring +44 7700 900123" });
  const messages = app.store.messages(run.sessionId);
  const { html, receipt } = shareHtml({ sessionId: run.sessionId }, messages);
  assert.ok(!html.includes(telegram), "a chat-app bot token must not survive");
  assert.ok(!html.includes("sk-proj-abcdefghijklmnopqrstuvwx1234"), "an API key must not survive");  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  assert.ok(!html.includes("7d9f1a2b3c4d5e6f7a8b9c0d"), "a value against a secret-looking name must not survive");
  assert.ok(receipt.secretsRemoved >= 3, `three plantings were expected, got ${receipt.secretsRemoved}`);
  assert.ok(html.includes("ada@example.com"), "contact details stay in unless the owner asks for them");
  const guarded = shareHtml({ sessionId: run.sessionId }, messages, RedactionSchema.parse({ contactDetails: true }));
  assert.ok(!guarded.html.includes("ada@example.com"), "with the option on, an address goes");
  assert.ok(!guarded.html.includes("7700 900123"), "and so does a phone number");
});

test("a share link closes itself after five wrong codes", async (t) => {
  const { app, server, call } = await served(t);
  const run = await app.runtime.run({ prompt: "something worth sharing" });
  const link = await call(`/api/sessions/${run.sessionId}/share`, { expiresInMinutes: 60 });
  for (const attempt of ["AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE"])
    assert.equal((await fetch(`${server.url}/share/${link.body.id}?code=${attempt}`)).status, 403, "a wrong code is refused");
  const shut = await fetch(`${server.url}/share/${link.body.id}?code=${link.body.code}`);
  assert.equal(shut.status, 403, "the right code no longer works once the link has closed");
  // The page says only that the link is not available; the reason is still there underneath.
  assert.doesNotMatch(await shut.text(), /too many wrong codes/);
  assert.throws(() => app.store.shares.open(link.body.id, link.body.code), /too many wrong codes/);
});

test("a profile waiting out wrong PINs cannot keep guessing", async (t) => {
  const { app, call } = await served(t);
  const made = await call("/api/profiles", { name: "Rey", pin: "8642" });
  for (let attempt = 0; attempt < 5; attempt++)
    assert.match((await call("/api/profiles/switch", { profileId: made.body.id, pin: "0000" })).body.error, /PIN is not right/);
  const locked = await call("/api/profiles/switch", { profileId: made.body.id, pin: "8642" });
  assert.match(locked.body.error, /Too many wrong PINs/, "even the right PIN waits out the lockout");
  app.store.profiles.now = () => Date.now() + 600000;
  assert.equal((await call("/api/profiles/switch", { profileId: made.body.id, pin: "8642" })).body.active.name, "Rey");
});

test("somebody else's profile reaches none of the owner's sharing, workflows, waiting line or days off", async (t) => {
  const { app, call } = await served(t);
  const ownersChat = await app.runtime.run({ prompt: "the owner's private conversation" });
  await call("/api/workflows", { name: "Owner's flow", steps: [{ name: "Ask", kind: "prompt", prompt: "hello" }] });
  const made = await call("/api/profiles", { name: "Ash", pin: "2468" });
  await call("/api/profiles/switch", { profileId: made.body.id, pin: "2468" });
  const minted = await call(`/api/sessions/${ownersChat.sessionId}/share`, { expiresInMinutes: 60 });
  assert.equal(minted.status, 400, "no link may be minted for a conversation that is not theirs");
  assert.match((await call("/api/workflows")).body.error, /belongs to the owner/);
  assert.match((await call("/api/queue", { prompt: "run this as the owner" })).body.error, /belongs to the owner/);
  assert.match((await call("/api/calendar")).body.error, /belongs to the owner/);
  const state = await call("/api/state");
  assert.deepEqual(state.body.collab.workflows, [], "nor are the owner's workflows listed to them");
  assert.deepEqual(state.body.collab.shares, []);
  // The assistant always works as the owner, so the tools must check the profile too, not just
  // the web routes: otherwise a task started under somebody else's name reaches them that way.
  await assert.rejects(
    () => app.runtime.executeTool("workflows.list", {}),
    // mac5/manual-actions: a hand-run tool is held to the profile's role first, so either refusal will do.
    /belongs to the owner|does not cover/,
    "the assistant's own workflow tools are refused while a profile is switched on",
  );
  await assert.rejects(
    () => app.runtime.executeTool("workflows.create", { name: "Sneaky", steps: [{ name: "Do it", kind: "tool", tool: "memory.put", args: { text: "x", source: "y" } }] }),
    /belongs to the owner|does not cover/,
  );
  await call("/api/profiles/switch", { profileId: null });
  assert.equal((await call("/api/workflows")).body.workflows.length, 1, "the owner still sees their own");
  assert.equal((await app.runtime.executeTool("workflows.list", {})).workflows.length, 1,
    "and the owner's own assistant still reaches them");
});

test("the assistant cannot say yes to a workflow's approval step; the owner still can", async (t) => {
  const { app, call } = await served(t);
  const made = await call("/api/workflows", { name: "Needs a yes", steps: [
    { name: "Check with me", kind: "approval", question: "Shall I go on?" },
    { name: "Then this", kind: "prompt", prompt: "carry on" },
  ] });
  const stopped = await call(`/api/workflows/${made.body.id}/run`, {});
  assert.equal(stopped.body.status, "waiting_approval");
  await assert.rejects(
    () => app.runtime.executeTool("workflows.resume", { id: made.body.id }),
    /waiting for the owner to say yes/,
    "the assistant's own tool must not approve it",
  );
  assert.equal((await call(`/api/workflows/${made.body.id}`)).body.status, "waiting_approval");
  const carried = await call(`/api/workflows/${made.body.id}/resume`, {});
  assert.equal(carried.body.status, "completed", "the owner's screen still says yes");
});

test("a workflow left working when the app closed is marked and can be carried on", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "branch-collab-"));
  t.after(() => discard(base));
  const first = await fixture(t, base);
  const made = first.app.workflows.create("local", { name: "Long one", steps: [
    { name: "Think", kind: "prompt", prompt: "think about it" },
  ] });
  const saved = first.app.store.get("workflows", "local", made.id).data;
  first.app.store.save("workflows", "local", made.id, { ...saved, status: "running" });
  await first.app.close();
  const second = await fixture(t, base);
  assert.equal(second.app.workflows.view("local", made.id).status, "interrupted",
    "reopening the folder must not leave it stuck as working");
  assert.equal((await second.app.workflows.run("local", made.id)).status, "completed");
});
