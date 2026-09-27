/**
 * Dogfood F8: an approval question lives in memory, so a task left waiting on one when Branch stopped was a zombie after
 * the restart: approving said "Nothing … is waiting", stopping it answered `cancelled:false`, and it held every
 * automatic update (Legion had six). On a real start such a task is marked as cut off, with a note: the owner carries
 * it on, and it asks again, or stops it. A question that outlives a restart is left alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, lostQuestionNote } from "../dist/server.js";
import { busyTaskCount } from "../dist/comfort/auto-update.js";

/**
 * A model that writes the file its message names, so the write stops on the owner's question; carried on after a
 * restart, it sees that call cut off and asks for it again, as a real model does.
 */
function writer() {
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(request.messages.findLast((m) => m.role === "user")?.content ?? ""));
    const cutOff = last?.role === "tool" && /"status":"interrupted"/.test(String(last.content));
    if (named && ((last?.role === "user") || cutOff))
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}
async function open(root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  return app;
}
/** A task stopped on an approval question, and one stopped on a question the owner's next message answers. */
async function before(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-lost-questions-"));
  // Deleted by each test after its own app is closed: Windows cannot delete an open database (EBUSY).
  const first = await open(root);
  const gated = await first.runtime.run({ prompt: "write a.txt" });
  assert.equal(gated.status, "needs_input", "control: the write stopped on the owner's question");
  const asked = first.store.createRun(first.runtime.owner, "plan my week");
  first.store.event(asked.id, "user.ask", { question: "Which week?" });
  first.store.finish(asked.id, "needs_input", "Which week?");
  await first.close();
  return { root, gated, asked };
}

test("F8 after a real restart, a task whose approval question was lost is cut off with a note, and holds no update", async (t) => {
  const { root, gated, asked } = await before(t);
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = app.store.run(gated.id);
  assert.equal(run.status, "interrupted", "no longer a question nobody can answer");
  assert.equal(app.store.events(gated.id).filter((event) => event.kind === "run.can_continue").at(-1)?.data.note, lostQuestionNote);
  assert.equal(app.store.run(asked.id).status, "needs_input", "a question the owner's next message answers still waits");
  assert.equal(busyTaskCount(app.store), 1, "only the question that can still be answered counts");
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response.json();
  };
  const waiting = (await call("state")).attention.find((item) => item.runId === gated.id);
  assert.equal(waiting?.canContinue, true, "the window offers to carry it on");
  assert.equal(waiting?.question, lostQuestionNote, "and says why");
  // Carried on, it asks again, so the owner can answer this time.
  const again = await app.runtime.resume(gated.id);
  assert.equal(again.status, "needs_input", "carried on, it stops on the question again");
  assert.equal(app.runtime.approvals.waiting(gated.sessionId).length, 1, "the question is asked again");
});

test("F8 a waiting task can be stopped, and its question goes with it; a start that is not the app changes nothing", async (t) => {
  const { root, gated } = await before(t);
  // A terminal command opens the same data (no presence): nothing it does may close anything.
  const terminal = await open(root);
  const quiet = await startServer(terminal, { dataDir: join(root, "data"), port: 0 });
  assert.equal(terminal.store.run(gated.id).status, "needs_input", "control: only a real start settles lost questions");
  await quiet.close();
  await terminal.close();
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const stop = (id) => fetch(`${server.url}/api/runs/${id}/cancel`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
  assert.deepEqual(await stop(gated.id), { cancelled: true }, "a task a restart cut off is stopped");
  assert.equal(app.store.run(gated.id).status, "cancelled");
  // One waiting on a live question in this process: stopped, and the question is dropped.
  const live = await app.runtime.run({ prompt: "write b.txt" });
  assert.equal(app.runtime.approvals.waiting(live.sessionId).length, 1, "control: its question is live");
  assert.deepEqual(await stop(live.id), { cancelled: true });
  assert.equal(app.store.run(live.id).status, "cancelled");
  assert.equal(app.runtime.approvals.waiting(live.sessionId).length, 0, "its question is gone too");
  const done = await app.runtime.run({ prompt: "say hi" });
  assert.deepEqual(await stop(done.id), { cancelled: false }, "a finished task is not stopped");
});

test("F8 in the window, the row of a task a restart cut off offers Continue and Stop, and Stop stops it", async (t) => {
  const { chromium } = await import("playwright");
  const { root, gated } = await before(t);
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  /* Redesign: what waits on the owner is Inbox › Needs you in the new window ("Everything a Trunk is waiting on you
     for"). The prototype's card for cut-off work is ".cut15" with "Pick up what the update cut off", with buttons
     "Pick it up" and "Leave it". Clicking "Leave it" cancels the task. */
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="needs"]').click();
  const row = page.locator("#main .cut15");
  await row.waitFor({ timeout: 30000 });
  await row.getByRole("button", { name: /^Leave it/ }).click();
  await row.waitFor({ state: "hidden", timeout: 20000 });
  assert.equal(app.store.run(gated.id).status, "cancelled");
  assert.deepEqual(errors, []);
});

// Q221-Q223 (NAS 39e8973): stopping a waiting task through a key it did not start is refused, as answering it is;
// stopping one task drops only its own questions, even when another has no fingerprint; and a question a wall asked
// under a command's id after the command ran does not mark that command as never run.
test("F8 follow-up: a key stops only its own waiting task, a stop drops only that task's questions, and a wall's question leaves its command as run", async (t) => {
  const { root, gated } = await before(t);
  // Before the restart: a command that ran, then the network wall asking about a site under the same call id.
  const first = await open(root);
  const walled = first.store.createRun(first.runtime.owner, "fetch the page");
  first.store.event(walled.id, "tool.started", { name: "shell.run", id: "c-wall" });
  first.store.event(walled.id, "policy.ask", { name: "network.site", id: "c-wall", target: "example.com" });
  first.store.finish(walled.id, "needs_input", "May it reach example.com?");
  await first.close();
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const notRun = (id) => app.store.events(id).filter((event) => event.kind === "run.call_not_run").map((event) => event.data.id);
  assert.equal(app.store.run(walled.id).status, "interrupted", "the wall's lost question is cut off too");
  assert.deepEqual(notRun(walled.id), [], "but the command it ran is not marked as never run");
  assert.equal(notRun(gated.id).length, 1, "control: the gate's own call still is");
  const stop = (id, key = server.token) => fetch(`${server.url}/api/runs/${id}/cancel`, { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" }).then(async (r) => ({ status: r.status, body: await r.json() }));
  // Two questions in one conversation: one with a fingerprint, one without (as the wall's and the tests' are).
  const live = await app.runtime.run({ prompt: "write b.txt" });
  const [withPrint] = app.runtime.approvals.waiting(live.sessionId);
  assert.ok(withPrint.fingerprint, "control: the write's question has a fingerprint");
  const other = app.store.createRun(app.runtime.owner, "reach a site", live.sessionId);
  app.store.finish(other.id, "needs_input", "May it reach example.com?");
  app.runtime.approvals.ask({ runId: other.id, sessionId: live.sessionId, tool: "network.site", target: "example.com", label: "Reach example.com",
    question: "May it reach example.com?", source: "owner", remember: "never", askedAt: new Date().toISOString() });
  assert.equal(app.runtime.approvals.waiting(live.sessionId).length, 2);
  // A run key that did not start the task is refused, as its answer would be.
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const refused = await stop(other.id, key);
  assert.equal(refused.status, 401, JSON.stringify(refused.body));
  assert.equal(app.store.run(other.id).status, "needs_input", "the key stopped nothing");
  assert.deepEqual((await stop(other.id)).body, { cancelled: true }, "the owner stops it");
  assert.deepEqual(app.runtime.approvals.waiting(live.sessionId).map((question) => question.runId), [live.id], "only its own question went");
});

// Q229 (NAS d157ab3): "Stop it" on a task waiting for its plan's yes stops the plan too, so the owner's next "ok" in
// that conversation is an ordinary message and never starts the plan they stopped.
test("F8 follow-up 2: stopping a task that waits on its plan stops the plan, and a later ok starts nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-lost-questions-"));
  // Deleted after the app closes (see below).
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  // What the conductor leaves when a plan waits for the owner (src/orchestration.ts start()).
  const run = app.store.createRun(app.runtime.owner, "plan my move");
  app.runtime.orchestration.savePlan({ runId: run.id, sessionId: run.sessionId, prompt: "plan my move",
    steps: [{ title: "Write the packing list", changes: true }], current: 0, approved: false, createdAt: new Date().toISOString(),
    decision: "waiting", clearedThrough: -1 });
  app.store.event(run.id, "plan.awaiting_approval", { steps: ["Write the packing list"] });
  app.store.finish(run.id, "needs_input", "Here is the plan. Shall I go ahead?");
  const stopped = await fetch(`${server.url}/api/runs/${run.id}/cancel`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
  assert.deepEqual(stopped, { cancelled: true });
  assert.equal(app.runtime.orchestration.plan(run.sessionId), undefined, "the stopped plan is gone");
  const later = await app.runtime.run({ prompt: "ok, thanks", sessionId: run.sessionId });
  assert.equal(app.store.events(later.id).filter((event) => event.kind.startsWith("plan.")).length, 0, "an ok starts no plan");
});
