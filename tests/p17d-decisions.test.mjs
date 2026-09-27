/**
 * P17-D §4: decision models on the owner's own connections (src/decision-models.ts).
 *
 * - Yes or no, pick one, a score and a filter are asked of the chosen connection, with no tools, and the answer is
 *   checked: a pick must be one of the choices, a filter may keep only lines it was given, a score is 1 to 10.
 * - Less sure than the owner's threshold on a separate decision model: the task's own model decides instead.
 * - A list longer than the owner's limit is split.
 * - The "last 24 hours" line counts decisions and their average time; a decision's words are not kept.
 * - Over HTTP: only a connection the owner has may be chosen.
 *
 * Mutation notes (each turns this file red), all in src/decision-models.ts:
 * - checkDecision: drop the `if (!choice) throw` line      -> "a choice that was not offered" fails.
 * - checkDecision: drop the filter range check              -> "a line it was not given" fails.
 * - decide: drop the `result.confidence < settings.minConfidence` re-ask -> "the task's own model decides" fails.
 * - once: drop the split (always `this.single`)              -> "a long list is split" fails.
 * - configure: drop the unknown-model refusal               -> the 400 fails.
 * - src/index.ts: create the decision's run as not temporary  -> "never adds a conversation" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A model that answers each kind of decision by rules; `said` collects what it was asked. */
function decider(name, answers) {
  const said = [];
  return { said, provider: { name, async complete(request) {
    const text = request.messages.map((m) => m.content).join("\n");
    said.push(text);
    for (const [pattern, answer] of answers) if (pattern.test(text)) return { content: JSON.stringify(typeof answer === "function" ? answer(text) : answer), toolCalls: [] };
    return { content: "{}", toolCalls: [] };
  } } };
}
const lineNumbers = (text) => [...text.matchAll(/^(\d+)\. (.*)$/gm)].filter((m) => /money|invoice|refund/i.test(m[2])).map((m) => Number(m[1]));

async function fixture(t, task, small) {
  const root = await mkdtemp(join(tmpdir(), "branch-p17d-decisions-"));
  const presets = [{ id: "task", name: "Task model", provider: task.provider, model: "task-1" },
    ...(small ? [{ id: "small", name: "Small model", provider: small.provider, model: "small-1" }] : [])];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  return { app, ask };
}

const RULES = [
  [/Answer yes or no/, { answer: true, confidence: 0.96, why: "It names an invoice and a due amount." }],
  [/Pick exactly one/, (text) => ({ choice: /late fee/.test(text) ? "ledger" : "Nobody", confidence: 0.91, why: "It is about a charge." })],
  [/Give a score/, { score: 8, confidence: 0.84, why: "A deadline with money attached." }],
  [/numbered lines/, (text) => ({ keep: /OUTSIDE/.test(text) ? [9] : lineNumbers(text), confidence: 0.9 })],
];

test("each kind is decided and checked against what was offered", async (t) => {
  const task = decider("task", RULES);
  const { app, ask } = await fixture(t, task);
  const pick = await ask("/api/decisions/decide", { kind: "pick", question: "Which Trunk should answer: late fee?", options: ["Scout", "Ledger", "Ada"] });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.deepEqual([pick.body.choice, pick.body.confidence, pick.body.escalated, pick.body.model.name], ["Ledger", 0.91, false, "Task model"], "written as offered");
  assert.equal(typeof pick.body.ms, "number");
  const yes = (await ask("/api/decisions/decide", { kind: "yes", question: "Is this an invoice?" })).body;
  assert.equal(yes.verdict, "yes");
  assert.equal((await ask("/api/decisions/decide", { kind: "score", question: "How urgent?" })).body.score, 8);
  const items = ["Invoice INV-1 from a supplier", "Lunch on Friday", "Refund of 61", "Lease reminder", "Card statement money"];
  const filter = (await ask("/api/decisions/decide", { kind: "filter", question: "Keep only the ones about money", items })).body;
  assert.deepEqual(filter.kept, [items[0], items[2], items[4]]);
  assert.deepEqual(filter.dropped, [items[1], items[3]]);

  const other = await ask("/api/decisions/decide", { kind: "pick", question: "Who reads the lease?", options: ["Scout", "Ledger"] });
  assert.ok(other.status >= 400, "refused");
  assert.match(other.body.error, /picked something that was not one of the choices, so no decision was made/);
  const outside = await ask("/api/decisions/decide", { kind: "filter", question: "Keep OUTSIDE lines", items: ["a", "b"] });
  assert.match(outside.body.error, /kept a line it was not given, so no decision was made/);
  const overview = (await ask("/api/decisions")).body;
  assert.equal(overview.lastDay.decisions, 4, "only the decisions that were made are counted");
  assert.equal(typeof overview.lastDay.averageMs, "number");
  assert.deepEqual(overview.settings, { model: "", minConfidence: 0.75, maxList: 400 });
  assert.deepEqual(app.store.recentSessions(app.runtime.owner, 20).sessions, [], "a decision never adds a conversation to the list");
});

test("a separate decision model less sure than the threshold hands the decision to the task's own model", async (t) => {
  const task = decider("task", RULES);
  const small = decider("small", [[/Answer yes or no/, { answer: false, confidence: 0.6, why: "Unsure." }], ...RULES]);
  const { ask } = await fixture(t, task, small);
  assert.equal((await ask("/api/decisions/settings", { model: "nope" })).status, 400, "only a connection the owner has");
  assert.deepEqual((await ask("/api/decisions/settings", { model: "small", minConfidence: 0.8 })).body.settings, { model: "small", minConfidence: 0.8, maxList: 400 });
  const unsure = (await ask("/api/decisions/decide", { kind: "yes", question: "Is this an invoice?" })).body;
  assert.deepEqual([unsure.verdict, unsure.escalated, unsure.model.name], ["yes", true, "Task model"]);
  assert.equal(small.said.length, 1);
  const surer = (await ask("/api/decisions/decide", { kind: "score", question: "How urgent?" })).body;
  assert.deepEqual([surer.escalated, surer.model.name], [false, "Small model"]);
});

test("a list longer than the limit is split, and every part is checked", async (t) => {
  const task = decider("task", RULES);
  const { ask } = await fixture(t, task);
  await ask("/api/decisions/settings", { maxList: 10 });
  const items = Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? `invoice ${i}` : `note ${i}`));
  const before = task.said.length;
  const answer = (await ask("/api/decisions/decide", { kind: "filter", question: "Keep only the ones about money", items })).body;
  assert.equal(task.said.length - before, 3, "three parts of at most 10");
  assert.deepEqual(answer.kept, ["invoice 0", "invoice 5", "invoice 10", "invoice 15", "invoice 20"]);
  assert.equal(answer.dropped.length, 20);
});
