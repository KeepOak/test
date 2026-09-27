/**
 * Long conversations stay coherent. When early history is folded into a summary, the summary keeps the pinned
 * messages, the decisions, the open to-do list, the files touched and the person's instructions — however many folds
 * later. The stand-in summariser is deliberately forgetful: it reads only the turns it is handed and never copies the
 * earlier summary forward, so whatever survives many folds survives because the engine keeps it (mergeSummaries,
 * src/session-summary.ts; recordedForSummary, src/runtime.ts).
 *
 * Mutation notes (each turns this file red):
 * - src/runtime.ts maybeCompact: use `parsed` instead of the merged summary and turn 3's decision is gone by turn 201.
 * - src/runtime.ts recordedForSummary: return {} and the file touched and the open to-do are gone.
 * - src/session-summary.ts keepEnds: keep only the newest entries and turn 3's decision is gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { mergeSummaries, parseSessionSummary, statedLists, summaryCaps } from "../dist/session-summary.js";

const isSummariser = (request) => /^Summarize the conversation below/.test(request.messages[0]?.content ?? "");
/** Reads only "user:" lines of the turns it is handed; the earlier summary above them is ignored. */
function forgetfulSummary(request) {
  const said = request.messages[1].content.split("\n").filter((line) => line.startsWith("user: ")).map((line) => line.slice(6));
  const pick = (tag) => said.filter((line) => line.includes(`${tag}:`)).map((line) => line.split(`${tag}:`)[1].trim());
  return { content: JSON.stringify({ goals: ["Build the invoicing tool"], decisions: pick("DECISION"), instructions: pick("INSTRUCTION"), todos: [], openQuestions: [], filesTouched: [] }), toolCalls: [] };
}
const filler = (n) => `Turn ${n}. ${"Some ordinary back and forth about layout, naming and colours that nobody needs later. ".repeat(4)}`;
const everything = (request) => request.messages.map((m) => m.content).join("\n");

async function fixture(t, answer) {
  const root = await mkdtemp(join(tmpdir(), "branch-long-conversation-"));
  const requests = [];
  const provider = { name: "scripted", complete: async (request) => {
    if (isSummariser(request)) return forgetfulSummary(request);
    requests.push(request);
    return answer(request);
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  // dogfood D22: the room is the model's own now (a hosted one has far more); this conversation is held to the 20,000 it was written for.
  saveKnobs(app.store, app.runtime.owner, "compaction", { compactAtPercent: 20, keepRecentMessages: 6, contextWindowTokens: 20000 });
  const post = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json();
    assert.ok(response.ok, JSON.stringify(json));
    return json;
  };
  return { app, requests, post };
}

/** The plain model: a file written at turn 7, a to-do at turn 9, otherwise a short answer. */
function ordinary(request) {
  const last = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const answered = request.messages.at(-1)?.role === "tool";
  if (!answered && /^Turn 7\./.test(last)) return { content: "", toolCalls: [{ id: "w7", name: "files.write", arguments: JSON.stringify({ path: "notes/plan.md", content: "the plan" }) }] };
  if (!answered && /^Turn 9\./.test(last)) return { content: "", toolCalls: [{ id: "t9", name: "todos.add", arguments: JSON.stringify({ text: "Send Acme the first invoice draft" }) }] };
  if (/What did we decide in turn 3/.test(last)) {
    const all = everything(request);
    const found = /we will store invoices in Postgres, not SQLite/.test(all);
    return { content: found ? "In turn 3 we decided to store invoices in Postgres, not SQLite." : "I no longer know.", toolCalls: [] };
  }
  return { content: "Noted.", toolCalls: [] };
}

test("a 200-turn conversation, folded many times, still knows turn 3's decision, the instructions, the to-do, the file and the pin", async (t) => {
  const { app, requests, post } = await fixture(t, ordinary);
  const first = await app.runtime.run({ prompt: filler(1) });
  const sessionId = first.sessionId;
  const say = (prompt) => app.runtime.run({ prompt, sessionId });
  await say(filler(2));
  await say("Turn 3. DECISION: we will store invoices in Postgres, not SQLite.");
  await say(filler(4));
  await say("Turn 5. INSTRUCTION: always write amounts in euros, never in dollars.");
  await say(filler(6));
  assert.equal((await say("Turn 7. Please write the plan down.")).status, "completed");
  await say(filler(8));
  assert.equal((await say("Turn 9. Put sending the first draft on the list.")).status, "completed");
  await say(filler(10));
  await say("Turn 11. FACT: the client is Acme GmbH in Hamburg.");
  const pinned = app.store.messages(sessionId).length; // not used as an id: the route below is given the row's id
  const rows = app.store.sqlite.prepare("SELECT id, body FROM messages WHERE session_id=? ORDER BY id").all(sessionId);
  const fact = rows.find((row) => JSON.parse(String(row.body)).content?.startsWith("Turn 11. FACT"));
  assert.ok(fact && pinned > 0);
  await post(`sessions/${sessionId}/pins`, { messageId: Number(fact.id), pinned: true });
  for (let turn = 12; turn <= 200; turn++) await say(turn === 150 ? "Turn 150. DECISION: invoices are numbered per year." : filler(turn));
  const folds = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.session_id=? AND e.kind='context.compacted'").get(sessionId).n;
  assert.ok(folds >= 5, `folded ${folds} times`);
  const asked = await post("run", { prompt: "What did we decide in turn 3?", sessionId });
  assert.equal(asked.status, "completed");
  assert.equal(asked.output, "In turn 3 we decided to store invoices in Postgres, not SQLite.");
  const seen = everything(requests.at(-1));
  assert.ok(!/^Turn 3\. DECISION/m.test(seen.split("Earlier in this conversation")[0] ?? ""), "turn 3 itself was folded away");
  assert.match(seen, /always write amounts in euros, never in dollars/, "the person's instruction");
  assert.match(seen, /Send Acme the first invoice draft/, "the open to-do");
  assert.match(seen, /notes\/plan\.md/, "the file touched");
  assert.match(seen, /Turn 11\. FACT: the client is Acme GmbH in Hamburg\./, "the pinned message, word for word");
  assert.match(seen, /invoices are numbered per year/, "a later decision too");
});

test("a task that spans a fold carries on: its own steps are not repeated and the earlier decision is still in front of it", async (t) => {
  const done = [];
  const big = "x".repeat(3000);
  const { app, requests } = await fixture(t, (request) => {
    const last = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (!/^Check all twelve files/.test(last)) return ordinary(request);
    const results = request.messages.filter((m) => m.role === "tool" && /^r\d+$/.test(m.toolCallId ?? "")).length;
    if (results < 12) return { content: "", toolCalls: [{ id: `r${results + 1}`, name: "files.read", arguments: JSON.stringify({ path: `part${results + 1}.txt` }) }] };
    return { content: /store invoices in Postgres/.test(everything(request)) ? "all twelve checked, Postgres as decided" : "lost the decision", toolCalls: [] };
  });
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(app.runtime.workspace, { recursive: true });
  for (let n = 1; n <= 12; n++) await writeFile(join(app.runtime.workspace, `part${n}.txt`), `${n} ${big}`);
  const first = await app.runtime.run({ prompt: "Turn 1. DECISION: we will store invoices in Postgres, not SQLite." });
  const say = (prompt) => app.runtime.run({ prompt, sessionId: first.sessionId, onTextDelta: () => undefined });
  for (let turn = 2; turn <= 12; turn++) await say(filler(turn));
  const task = await say("Check all twelve files, one at a time.");
  assert.equal(task.status, "completed", task.output);
  assert.equal(task.output, "all twelve checked, Postgres as decided");
  const kinds = app.store.events(task.id).map((e) => e.kind);
  assert.ok(kinds.includes("context.compacted"), "the fold happened inside this task");
  const reads = app.store.events(task.id).filter((e) => e.kind === "tool.started").map((e) => e.data.id);
  assert.deepEqual(reads, Array.from({ length: 12 }, (_, i) => `r${i + 1}`), "each file read once, in order");
  void done; void requests;
});

test("merging folds keeps both ends of a long list and each entry once", () => {
  const decisions = Array.from({ length: 60 }, (_, i) => `decision ${i + 1}`);
  const merged = mergeSummaries({ goals: [], decisions: decisions.slice(0, 30), instructions: ["Always euros"], openQuestions: ["q"], todos: ["old"], filesTouched: [] },
    { goals: [], decisions: decisions.slice(28), instructions: ["always euros"], openQuestions: [], todos: ["new"], filesTouched: [] }, { filesTouched: ["a.md"] });
  assert.equal(merged.decisions.length, summaryCaps.decisions);
  assert.equal(merged.decisions[0], "decision 1", "the oldest decision stays");
  assert.equal(merged.decisions.at(-1), "decision 60", "the newest too");
  assert.equal(new Set(merged.decisions).size, merged.decisions.length);
  assert.deepEqual(merged.instructions, ["Always euros"], "the same instruction once");
  assert.deepEqual(merged.todos, ["new"], "the to-do list is the newest state");
  assert.deepEqual(merged.openQuestions, ["q"], "kept when the newest summary says nothing");
  assert.deepEqual(merged.filesTouched, ["a.md"]);
});

test("a fold that states an empty to-do list clears it, and a summary longer than the stored cut parses whole", () => {
  const earlier = { goals: ["ship"], decisions: [], instructions: [], openQuestions: ["which host?"], todos: ["write tests"], filesTouched: [] };
  const reply = JSON.stringify({ goals: ["ship"], todos: [], openQuestions: [], decisions: Array.from({ length: 40 }, (_, i) => `decision ${i + 1} `.padEnd(200, "x")) });
  assert.ok(reply.length > 6000, "longer than the stored text's cut");
  const parsed = parseSessionSummary(reply);
  assert.equal(parsed.decisions.length, 40);
  const merged = mergeSummaries(earlier, parsed, {}, statedLists(reply));
  assert.deepEqual(merged.todos, [], "everything was done");
  assert.deepEqual(merged.openQuestions, [], "everything was answered");
  const silent = mergeSummaries(earlier, parseSessionSummary(JSON.stringify({ goals: ["ship"] })), {}, statedLists(JSON.stringify({ goals: ["ship"] })));
  assert.deepEqual(silent.todos, ["write tests"], "a list the fold did not state is kept");
});
