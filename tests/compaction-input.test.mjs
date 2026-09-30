/**
 * P0 (self-build): a fold reads the whole folded range. The summariser used to get only the first 60,000 characters,
 * so the newest part of the range (what was being done when the room ran out) never reached the summary. It now gets
 * the start and the end with the middle marked as left out (Hermes Agent's bound), the owner's own words are kept word
 * for word beside the summary (Codex's compact), and a summariser refused as too long is asked again without the oldest
 * part. The model is scripted; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";
import { boundSummaryInput, ownerWordsSection } from "../dist/compaction-input.js";
import { ProviderHttpError } from "../dist/provider-retry.js";

const isSummariser = (request) => /Summarize the conversation below/.test(request.messages[0].content);
async function fixture(t, summarise = () => ({ content: "Handoff: renaming photos in /pics.", toolCalls: [] })) {
  const root = await mkdtemp(join(tmpdir(), "branch-compaction-input-"));
  const requests = [];
  const provider = { name: "scripted", async complete(request) {
    requests.push({ messages: request.messages.map((m) => ({ ...m })) });
    if (isSummariser(request)) return summarise(request, requests.filter(isSummariser).length);
    return { content: "Carrying on from the summary.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  return { app, requests };
}
const big = (n) => `Turn ${n}: ` + "photo renaming details ".repeat(200);
/** A long stored conversation: far more than 60,000 characters fold, with marked words near the end of the folded part. */
async function longConversation(app) {
  const first = await app.runtime.run({ prompt: "start renaming photos in /pics" });
  const sessionId = first.sessionId;
  for (let n = 1; n <= 40; n++) {
    const role = n % 2 ? "user" : "assistant";
    const content = n === 39 ? "Never rename anything in /pics/raw; LATE-OWNER-RULE." : n === 38 ? `${big(n)} LATE-WORK-MARK` : big(n);
    app.store.message(sessionId, { role, content });
  }
  app.store.message(sessionId, { role: "user", from: "branch", content: "BRANCH-OWN-NOTE: the last reply was empty." });
  for (let n = 41; n <= 48; n++) app.store.message(sessionId, { role: n % 2 ? "user" : "assistant", content: `Recent ${n}` });
  return sessionId;
}

test("the summariser's input keeps 45% from the start and 55% from the end, and says how much was left out", () => {
  assert.equal(boundSummaryInput("short", 100), "short");
  const text = "A".repeat(50_000) + "M".repeat(100_000) + "Z".repeat(50_000);
  const bounded = boundSummaryInput(text, 60_000);
  assert.ok(bounded.length <= 60_000, `${bounded.length}`);
  assert.ok(bounded.startsWith("A".repeat(20_000)));
  assert.ok(bounded.endsWith("Z".repeat(30_000)), "the end of the range is kept");
  const omitted = Number(/omitted ([\d,]+) chars/.exec(bounded)[1].replace(/,/g, ""));
  assert.ok(Math.abs(omitted - (text.length - bounded.length)) < 200, `${omitted} marked, ${text.length - bounded.length} left out`);
  const head = bounded.indexOf("\n\n..."), tail = bounded.length - bounded.lastIndexOf("...\n\n") - 5;
  assert.ok(Math.abs(head / (head + tail) - 0.45) < 0.01, `head share ${head / (head + tail)}`);
});

test("the owner's words are kept newest first up to the budget, given back oldest first, the last one cut", () => {
  assert.equal(ownerWordsSection([], 100), null);
  const section = ownerWordsSection(["third", "second", "first one is long"], 13);
  assert.match(section, /word for word/);
  assert.match(section, /- second\n- third$/);
  assert.equal(ownerWordsSection(["abcdefghij"], 4).endsWith("- abcd [cut]"), true);
});

test("a long folded range: its end reaches the summariser, and the owner's own words stay word for word", async (t) => {
  const { app, requests } = await fixture(t);
  const sessionId = await longConversation(app);
  const run = await app.runtime.run({ prompt: "what is left to do?", sessionId });
  assert.equal(run.status, "completed", run.output);
  const summariser = requests.find(isSummariser);
  assert.ok(summariser, "the conversation was folded");
  const input = summariser.messages[1].content;
  assert.ok(input.length <= 60_000, `the summariser's input is bounded (${input.length})`);
  assert.match(input, /Turn 1:/, "the start of the range is read");
  assert.match(input, /LATE-WORK-MARK/, "the end of the range is read too (it used to be cut off)");
  assert.match(input, /omitted [\d,]+ chars from the middle/);
  const answer = requests.at(-1).messages;
  assert.match(answer[1].content, /compacted summary/);
  assert.match(answer[1].content, /Never rename anything in \/pics\/raw; LATE-OWNER-RULE\./, "the owner's words are kept as they said them");
  assert.ok(!answer[1].content.includes("BRANCH-OWN-NOTE"), "Branch's own notes are not the owner's words");
  const event = app.store.events(run.id).find((e) => e.kind === "context.compacted");
  assert.ok(event.data.ownerWordsChars > 0);
  assert.ok(event.data.estimatedAfter < event.data.threshold, `after ${event.data.estimatedAfter}, threshold ${event.data.threshold}`);
  // The next task in the conversation starts from the saved fold, the owner's words still in it.
  const next = await app.runtime.run({ prompt: "and after that?", sessionId });
  assert.equal(next.status, "completed");
  assert.match(requests.at(-1).messages.find((m) => /compacted summary/.test(m.content)).content, /LATE-OWNER-RULE/);
  // The owner's summary itself stays the summary alone.
  assert.ok(!(app.store.sessionSummary(app.runtime.owner, sessionId).text ?? "").includes("LATE-OWNER-RULE"));
});

test("a summariser refused as too long is asked again without the oldest part", async (t) => {
  const { app, requests } = await fixture(t, (request, n) => {
    if (n === 1) throw new ProviderHttpError(400, undefined, "context_length_exceeded");
    return { content: "Handoff: renaming photos in /pics.", toolCalls: [] };
  });
  const sessionId = await longConversation(app);
  const run = await app.runtime.run({ prompt: "what is left to do?", sessionId });
  assert.equal(run.status, "completed", run.output);
  const asked = requests.filter(isSummariser);
  assert.equal(asked.length, 2, "asked once more");
  assert.match(asked[0].messages[1].content, /user: start renaming photos in \/pics/);
  assert.ok(!asked[1].messages[1].content.includes("user: start renaming photos in /pics"), "the oldest part was left out the second time");
  assert.match(asked[1].messages[1].content, /LATE-WORK-MARK/);
  assert.ok(app.store.events(run.id).some((e) => e.kind === "context.compaction_trimmed"));
  assert.ok(app.store.events(run.id).some((e) => e.kind === "context.compacted"));
});
