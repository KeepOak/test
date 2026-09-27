/**
 * Undoing a goal (src/goal-undo.ts): the dialog's promise, kept. Its files go back, its drafts are deleted where they were
 * written (only while they are still drafts), and its facts are forgotten through the memory service, checkpoints included,
 * so putting a memory checkpoint back cannot bring one back. Every workspace is a temporary folder; nothing is dialled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, GoalUndo, goalDoneScore, saveGoalUndoSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { GoogleConnector } from "../dist/personal/google.js";
import { MicrosoftConnector } from "../dist/personal/microsoft.js";
import { fakeStore, fakeWeb, on } from "./personal-kit.mjs";

const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const exists = (path) => stat(path).then(() => true, () => false);

/** A real app. Each non-grading model call takes the next step; the grader always says done, so a goal has one round. */
async function goalApp(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-goal-undo-left-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "before the goal");
  const app = await createBranch({ workspace, dataDir: join(root, "private"), snapshotGit: null,
    provider: { name: "scripted", async complete(request) {
      if (request.responseFormat?.name === "goal_grade" || /judging whether a goal/.test(request.messages.at(-1).content))
        return { content: JSON.stringify({ score: goalDoneScore, missing: [], blocked: false }), toolCalls: [] };
      return steps.shift() ?? { content: "working on it", toolCalls: [] };
    } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveGoalUndoSettings(app.store, "local", { goal: "on" });
  return { app, root, workspace };
}
async function settled(app, sessionId) {
  for (let i = 0; i < 400; i++) {
    const goal = app.goals.status(sessionId);
    if (goal && goal.status !== "working") return goal;
    await app.goals.settled(sessionId);
  }
  throw new Error("the goal never settled");
}
/** A goal whose one round reads notes.txt, changes it, makes made.txt and learns a fact; plus a fact from elsewhere. */
async function goalThatDidThings(t) {
  const { app, root, workspace } = await goalApp(t, [
    { content: "", toolCalls: [call("o1", "memory.put", { text: "The owner's office is on the third floor", source: "said" })] },
    { content: "Saved.", toolCalls: [] },
    { content: "", toolCalls: [call("r1", "files.read", { path: "notes.txt" })] },
    { content: "", toolCalls: [call("w1", "files.write", { path: "notes.txt", content: "changed by the goal" }),
      call("w2", "files.write", { path: "made.txt", content: "made by the goal" }),
      call("m1", "memory.put", { text: "You buy printer paper about every six weeks", source: "the order history" })] },
    { content: "Done for now.", toolCalls: [] },
  ]);
  const other = await app.runtime.run({ prompt: "remember where my office is" });
  const started = await app.goals.start({ objective: "Reorder the paper" });
  const goal = await settled(app, started.sessionId);
  assert.equal(goal.status, "done");
  assert.equal(goal.runIds.length, 1, "the goal kept which task was its round");
  // Two drafts, as gmail.draft and outlook.draft write them down: one by the goal, one by another conversation.
  app.store.event(goal.runIds[0], "tool.completed", { name: "gmail.draft", id: "d1", result: { draftId: "draft-goal", to: ["orders@example.com"], subject: "Paper", sent: false } });
  app.store.event(other.id, "tool.completed", { name: "gmail.draft", id: "d2", result: { draftId: "draft-other", to: ["someone@example.com"], subject: "Hi", sent: false } });
  return { app, root, workspace, goal, other };
}
const texts = (app) => app.store.list("memory", "local").map((fact) => fact.data.text).sort();

function undoer(app, deleted) {
  return new GoalUndo({ db: app.store.sqlite, owner: "local", goals: app.goals, history: app.store.workspaceHistory, files: app.files,
    memory: app.memory.backend, drafts: { "gmail.draft": async (id) => { deleted.push(id); return "deleted"; } } });
}

test("undoing a goal puts its files back, deletes its draft and forgets its fact; the rest stays", async (t) => {
  const { app, workspace, goal } = await goalThatDidThings(t);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "changed by the goal");
  assert.equal(texts(app).length, 2);
  const deleted = [];
  const undo = undoer(app, deleted);
  const preview = await undo.preview(goal.sessionId);
  assert.equal(preview.rounds, 1);
  assert.deepEqual(preview.files.map((f) => [f.path, f.round, f.existed]).sort(), [["made.txt", 1, false], ["notes.txt", 1, true]]);
  assert.deepEqual(preview.drafts.map((d) => [d.id, d.to, d.round]), [["draft-goal", ["orders@example.com"], 1]]);
  assert.deepEqual(preview.facts.map((f) => f.text), ["You buy printer paper about every six weeks"]);
  await app.memory.backend.search("local", "printer paper"); // the fact is found by search, so it is in the index
  const indexed = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM memory_terms WHERE memory_id=?").get(preview.facts[0].id).n;
  assert.ok(indexed > 0, "search keeps a copy of the fact before the undo");
  const done = await undo.undo(goal.sessionId);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before the goal");
  assert.equal(await exists(join(workspace, "made.txt")), false);
  assert.deepEqual(deleted, ["draft-goal"], "only the goal's own draft is deleted");
  assert.deepEqual(done.drafts.map((d) => d.outcome), ["deleted"]);
  assert.deepEqual(done.facts.map((f) => f.outcome), ["forgotten"]);
  assert.deepEqual(texts(app), ["The owner's office is on the third floor"], "a fact from another conversation stays");
  assert.equal(app.goals.status(goal.sessionId), null, "the goal is gone from the conversation");
  assert.ok(app.store.messages(goal.sessionId).some((m) => m.role === "user" && /Reorder the paper/.test(m.content)), "the conversation itself stays");
  const kept = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE data LIKE '%printer paper%'").get().n;
  assert.equal(kept, 0, "no kept wording of the forgotten fact is left to bring back");
  const paper = preview.facts[0].id;
  for (const table of ["memory_terms", "memory_vectors", "memory_uses"])
    assert.equal(app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id=?`).get(paper).n, 0, `nothing of it is left in ${table}`);
});

test("a memory checkpoint taken while the goal's fact was known cannot bring it back after the undo", async (t) => {
  const { app, goal } = await goalThatDidThings(t);
  const checkpoint = app.store.review.checkpoint("local", { label: "Before" });
  await undoer(app, []).undo(goal.sessionId);
  assert.deepEqual(texts(app), ["The owner's office is on the third floor"]);
  app.store.review.restoreCheckpoint("local", checkpoint.id);
  assert.deepEqual(texts(app), ["The owner's office is on the third floor"], "putting the checkpoint back does not bring the goal's fact back");
});

test("a fact the memory service would not forget is said to be kept, not forgotten", async (t) => {
  const { app, goal } = await goalThatDidThings(t);
  const checkpoint = app.store.review.checkpoint("local", { label: "Before failed undo" });
  const undo = new GoalUndo({ db: app.store.sqlite, owner: "local", goals: app.goals, history: app.store.workspaceHistory, files: app.files,
    memory: { list: (owner) => app.memory.backend.list(owner), forget: async () => false }, drafts: { "gmail.draft": async () => "deleted" } });
  const done = await undo.undo(goal.sessionId);
  assert.deepEqual(done.facts.map((f) => [f.outcome, f.reason]), [["failed", "The memory service did not forget this fact, so it is still kept."]]);
  assert.ok(texts(app).includes("You buy printer paper about every six weeks"));
  assert.ok(app.goals.status(goal.sessionId), "the recorded rounds remain available for a retry");
  app.store.review.restoreCheckpoint("local", checkpoint.id);
  assert.ok(texts(app).includes("You buy printer paper about every six weeks"), "failed deletion keeps its checkpoint copy");
  const retry = await undoer(app, []).undo(goal.sessionId);
  assert.equal(retry.facts[0].outcome, "forgotten");
  assert.equal(app.goals.status(goal.sessionId), null);
});

test("a fact the owner edited after the goal saved it stays; a draft already sent is left alone", async (t) => {
  const { app, goal } = await goalThatDidThings(t);
  const paper = app.store.list("memory", "local").find((fact) => /printer paper/.test(fact.data.text));
  app.store.updateMemory("local", { id: paper.id, text: "I buy paper every two months", source: "owner", expectedRevision: 1 }, "");
  const undo = new GoalUndo({ db: app.store.sqlite, owner: "local", goals: app.goals, history: app.store.workspaceHistory, files: app.files,
    memory: app.memory.backend, drafts: { "gmail.draft": async () => "gone" } });
  assert.deepEqual((await undo.preview(goal.sessionId)).facts, []);
  const done = await undo.undo(goal.sessionId);
  assert.deepEqual(done.drafts.map((d) => d.outcome), ["gone"]);
  assert.ok(texts(app).includes("I buy paper every two months"));
});

test("a goal still working is stopped first; one that never kept its rounds is refused, not guessed", async (t) => {
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  // The round's model call waits until the task is cancelled, so the goal is working when Undo is pressed.
  const { app } = await goalApp(t, []);
  const steps = [];
  const provider = { name: "held", async complete(request) {
    if (request.responseFormat?.name === "goal_grade") return { content: JSON.stringify({ score: 0.1, missing: ["more"], blocked: false }), toolCalls: [] };
    if (steps.length) return steps.shift();
    reached();
    await new Promise((resolve) => { if (request.signal.aborted) resolve(); request.signal.addEventListener("abort", resolve, { once: true }); });
    throw request.signal.reason ?? new Error("stopped");
  } };
  const root = await mkdtemp(join(tmpdir(), "branch-goal-undo-busy-"));
  const busy = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), snapshotGit: null, provider });
  t.after(async () => { await busy.close(); await discardTemp(root); });
  saveGoalUndoSettings(busy.store, "local", { goal: "on" });
  const started = await busy.goals.start({ objective: "Keep going" });
  await waiting;
  assert.equal(busy.goals.status(started.sessionId).status, "working");
  const done = await undoer(busy, []).undo(started.sessionId);
  assert.equal(done.rounds, 1);
  assert.equal(busy.goals.status(started.sessionId), null);
  // A goal saved before rounds were kept.
  const legacy = await app.runtime.run({ prompt: "an older goal's round" });
  app.store.save("settings", "local", `goal:${legacy.sessionId}`, { sessionId: legacy.sessionId, objective: "old", status: "done", round: 1, maxRounds: 6,
    score: 1, best: 1, flatRounds: 0, missing: [], reason: "", checks: null, startedAt: new Date().toISOString(), elapsedMs: 0, activeSince: null, lastRunId: legacy.id });
  await assert.rejects(undoer(app, []).preview(legacy.sessionId), /cannot be undone in one step/);
  await assert.rejects(undoer(app, []).undo(legacy.sessionId), /cannot be undone in one step/);
});

test("the route: the owner previews and undoes; a stranger's conversation and a body are refused; no connector is a reason", async (t) => {
  const { app, root, goal } = await goalThatDidThings(t);
  const server = await startServer(app, { dataDir: join(root, "private"), port: 0 });
  t.after(() => server.close());
  const ask = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const preview = await ask(`/api/sessions/${goal.sessionId}/goal/undo`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.facts.length, 1);
  assert.equal((await ask(`/api/sessions/00000000-0000-4000-8000-00000000abcd/goal/undo`)).status, 400);
  assert.equal((await ask(`/api/sessions/${goal.sessionId}/goal/undo`, { force: true })).status, 400);
  const done = await ask(`/api/sessions/${goal.sessionId}/goal/undo`, {});
  assert.equal(done.status, 200);
  assert.equal(done.body.drafts[0].outcome, "failed", "Google is not switched on here, so the draft is reported, not claimed deleted");
  assert.match(done.body.drafts[0].reason, /Google/);
  assert.equal(done.body.facts[0].outcome, "forgotten");
  assert.ok((await ask(`/api/sessions/${goal.sessionId}/goal`)).body.goal, "a failed outside draft deletion remains retryable");
});

const signedIn = () => ({ token: async () => "access-token-1", settings: () => ({ drafts: true }) });

test("Gmail: the draft is deleted by its id; one already sent (gone from drafts) is left alone", async () => {
  const store = fakeStore();
  on(store, "google");
  const web = fakeWeb([[/\/drafts\/keep-me$/, (url, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : {})]]);
  const google = new GoogleConnector(store, "local", web.fetch, signedIn());
  assert.equal(await google.deleteDraft("keep-me"), "deleted");
  assert.equal(web.seen.at(-1).method, "DELETE");
  assert.match(web.seen.at(-1).url, /\/users\/me\/drafts\/keep-me$/);
  assert.equal(await google.deleteDraft("sent-already"), "gone");
  assert.equal(web.seen.some((r) => /send|messages\//.test(r.url)), false, "nothing but the draft is touched");
});

test("Outlook: only a message that is still a draft is deleted; a sent one is never deleted", async () => {
  const store = fakeStore();
  on(store, "microsoft");
  const web = fakeWeb([
    [/\/messages\/still-draft\?\$select=isDraft$/, { isDraft: true, "@odata.etag": "W/\"v1\"" }],
    [/\/messages\/still-draft$/, (url, init) => new Response(null, { status: init.headers["if-match"] === "W/\"v1\"" ? 204 : 412 })],
    [/\/messages\/was-sent\?\$select=isDraft$/, { isDraft: false, "@odata.etag": "W/\"v9\"" }],
    [/\/messages\/sent-meanwhile\?\$select=isDraft$/, { isDraft: true, "@odata.etag": "W/\"v1\"" }],
    [/\/messages\/sent-meanwhile$/, () => new Response("{}", { status: 412 })],
  ]);
  const outlook = new MicrosoftConnector(store, "local", web.fetch, signedIn());
  assert.equal(await outlook.deleteDraft("still-draft"), "deleted");
  assert.equal(await outlook.deleteDraft("was-sent"), "sent");
  assert.equal(await outlook.deleteDraft("gone-now"), "gone");
  assert.equal(await outlook.deleteDraft("sent-meanwhile"), "sent", "sent between the read and the delete: Outlook refuses, and it is left alone");
  const deletes = web.seen.filter((r) => r.method === "DELETE");
  assert.deepEqual(deletes.map((r) => r.url.split("/").at(-1)), ["still-draft", "sent-meanwhile"]);
  assert.ok(deletes.every((r) => r.headers["if-match"]), "every delete names the exact draft it read");
});
