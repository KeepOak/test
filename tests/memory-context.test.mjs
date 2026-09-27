import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-memory-context-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  const app = await createBranch(provider ? { ...options, provider } : options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const answering = (content) => ({ name: "answering", async complete() { return { content, toolCalls: [] }; } });
const put = (app, text, extra = {}) =>
  app.store.save("memory", "local", `fact-${Math.random().toString(36).slice(2, 10)}`, { text, source: "Owner", ...extra });
const texts = (records) => records.map((record) => record.data.text).sort();

/* A stand-in for a provider's /embeddings route: every text lands on one of a few fixed axes, so
   two ways of saying the same thing come out close together and a query matches by meaning. */
const AXES = [["tea", "beverage", "drink", "brew"], ["bike", "cycling", "ride"], ["berlin", "city", "lives"]];
const vectorFor = (text) => AXES.map((group) => (group.some((word) => text.toLowerCase().includes(word)) ? 1 : 0)).concat([0.02]);
async function embeddingServer(t) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body).input;
      calls.push({ path: request.url, count: input.length });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: vectorFor(text) })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, calls };
}

test("facts saved twice are offered as one merge suggestion and nothing is removed until the owner accepts", async (t) => {
  const { app } = await fixture(t);
  const first = put(app, "The owner prefers tea in the morning");
  const second = put(app, "Owner prefers tea in the morning");
  const alone = put(app, "The garage door code is 4417");

  const review = app.memory.hygiene.review("local");
  assert.equal(review.duplicates.length, 1, "the two wordings are one group");
  assert.ok(review.duplicates[0].similarity >= 0.8);
  assert.ok(!review.duplicates[0].drop.includes(alone.id));

  const { staged } = app.memory.hygiene.suggest("local");
  assert.equal(staged.length, 1);
  assert.equal(staged[0].kind, "merge");
  assert.equal(app.store.list("memory", "local").length, 3, "suggesting changes nothing");
  assert.equal(app.store.review.proposals("local").length, 1);

  const applied = await app.store.review.decide("local", staged[0].id, true);
  assert.equal(applied.applied.setAside.length, 1);
  const left = app.store.list("memory", "local");
  assert.equal(left.length, 2, "one of the pair is set aside, the unrelated fact is untouched");
  assert.ok(left.some((record) => record.id === alone.id));
  const archived = app.store.archivedMemory("local");
  assert.equal(archived.length, 1);
  assert.match(archived[0].note, /same/i, "the archived copy says why it was set aside");
  assert.ok([first.id, second.id].includes(archived[0].id));
  assert.equal(app.store.review.proposals("local").length, 0, "the suggestion is decided");
  // Nothing was destroyed: the set-aside fact goes straight back.
  const back = app.store.restoreMemory("local", archived[0].id);
  assert.equal(back.data.text, archived[0].data.text);
});

test("a newer fact about the same subject wins and the older one is archived with a note, only through review", async (t) => {
  const { app } = await fixture(t);
  // Saved newest-first on purpose: which one wins comes from when it became true, not when it was typed.
  const newer = put(app, "Preferred drink: coffee", { validFrom: "2026-06-01T00:00:00.000Z" });
  const older = put(app, "Preferred drink: tea", { validFrom: "2026-01-01T00:00:00.000Z" });
  put(app, "Preferred bicycle: the blue one", { validFrom: "2026-01-01T00:00:00.000Z" });

  const review = app.memory.hygiene.review("local");
  assert.equal(review.contradictions.length, 1);
  assert.equal(review.contradictions[0].newer.id, newer.id);
  assert.equal(review.contradictions[0].older.id, older.id);

  const { staged } = app.memory.hygiene.suggest("local");
  assert.deepEqual(staged.map((p) => p.kind), ["archive"]);
  assert.equal(app.store.list("memory", "local").length, 3, "the older fact is still there while the suggestion waits");

  await app.store.review.decide("local", staged[0].id, true);
  const left = app.store.list("memory", "local");
  assert.equal(left.length, 2);
  assert.ok(left.some((record) => record.id === newer.id));
  assert.ok(!left.some((record) => record.id === older.id));
  const archived = app.store.archivedMemory("local").find((record) => record.id === older.id);
  assert.match(archived.note, /coffee/, "the note names the newer fact");

  // A label that heads a list is not a subject: two notes do not disagree with each other.
  put(app, "Note: buy milk", { validFrom: "2026-02-01T00:00:00.000Z" });
  put(app, "Note: call the dentist", { validFrom: "2026-03-01T00:00:00.000Z" });
  put(app, "Address: 12 Elm Row", { validFrom: "2026-02-01T00:00:00.000Z" });
  put(app, "Address: 40 Oak Lane", { validFrom: "2026-03-01T00:00:00.000Z" });
  assert.deepEqual(app.memory.hygiene.review("local").contradictions, [], "a one-word or list label is not a subject");

  // A rejected suggestion changes nothing at all.
  const second = put(app, "Preferred drink: cocoa", { validFrom: "2026-09-01T00:00:00.000Z" });
  const before = app.store.list("memory", "local").length;
  const again = app.memory.hygiene.suggest("local");
  assert.deepEqual(again.staged.map((proposal) => proposal.kind), ["archive"]);
  await app.store.review.decide("local", again.staged[0].id, false);
  assert.equal(app.store.list("memory", "local").length, before);
  assert.ok(app.store.list("memory", "local").some((record) => record.id === second.id));
});

test("the facts that are recent, used and owner-confirmed come first, and the conversation snapshot follows that order", async (t) => {
  const { app } = await fixture(t);
  const guessed = put(app, "They might like jazz", { sourceRunId: "some-run" });
  const confirmed = put(app, "They live in Berlin");
  app.memory.retrieval.noteUse("local", [confirmed.id, confirmed.id, confirmed.id]);

  const ranking = app.memory.retrieval.ranking("local");
  assert.equal(ranking[0].record.id, confirmed.id);
  assert.equal(ranking[0].uses, 3);
  assert.ok(ranking[0].importance > ranking.at(-1).importance);
  assert.ok(ranking.some((entry) => entry.record.id === guessed.id));

  const snapshot = app.store.review.sessionSnapshot("local", "a-conversation");
  assert.match(snapshot.text.split("\n")[0], /Berlin/, "the most useful fact leads the snapshot");

  // When the store is nearly full, the least useful facts are the ones offered up.
  app.store.configureMemory("local", { maxFacts: 2 });
  const nearlyFull = app.memory.hygiene.review("local");
  assert.equal(nearlyFull.capacity.nearlyFull, true);
  assert.equal(nearlyFull.leastUseful[0].id, guessed.id);
  const { staged } = app.memory.hygiene.suggest("local");
  assert.ok(staged.some((proposal) => proposal.kind === "forget" && proposal.memoryIds.includes(guessed.id)));
  assert.equal(app.store.list("memory", "local").length, 2, "nothing is forgotten without the owner");
});

test("facts are found by their words and by meaning, and turning meaning off falls back to words alone", async (t) => {
  const { endpoint, calls } = await embeddingServer(t);
  const provider = { name: "embedding-fixture", embeddings: () => ({ endpoint, apiKey: "test-key" }), async complete() { return { content: "", toolCalls: [] }; } };
  const { app } = await fixture(t, provider);
  const tea = put(app, "Preferred beverage: green tea");
  const bike = put(app, "Rides a bike to work every day");

  assert.equal(app.memory.retrieval.view("local").meaningSearch, true);
  const indexed = await app.memory.retrieval.index("local");
  assert.equal(indexed.embedded, 2);
  assert.ok(calls.length >= 1);

  const byWords = await app.memory.retrieval.search("local", "beverage");
  assert.equal(byWords[0].record.id, tea.id);
  assert.ok(["words", "both"].includes(byWords[0].matched));

  // "brew" appears in no fact, so only the meaning search can find the tea one.
  const byMeaning = await app.memory.retrieval.search("local", "favourite brew");
  assert.equal(byMeaning[0].record.id, tea.id);
  assert.equal(byMeaning[0].matched, "meaning");
  assert.ok(byMeaning[0].score > 0);

  const cycling = await app.memory.retrieval.search("local", "cycling");
  assert.equal(cycling[0].record.id, bike.id);

  const off = app.memory.retrieval.configure("local", { useEmbeddings: false });
  assert.equal(off.useEmbeddings, false);
  assert.equal(app.memory.retrieval.view("local").meaningSearch, false);
  assert.deepEqual(await app.memory.retrieval.search("local", "favourite brew"), [], "meaning is off, so a word-free query finds nothing");
  const stillWords = await app.memory.retrieval.search("local", "beverage");
  assert.equal(stillWords[0].record.id, tea.id);
  assert.equal(stillWords[0].matched, "words");
});

test("without a key for meaning, the same search still works on words alone", async (t) => {
  const { app } = await fixture(t);
  const fact = put(app, "The spare key is under the blue pot");
  assert.equal(app.memory.retrieval.view("local").meaningSearch, false);
  assert.deepEqual((await app.memory.retrieval.index("local")), { embedded: 0, reason: "meaning search is not available" });
  const results = await app.memory.retrieval.search("local", "spare key");
  assert.equal(results[0].record.id, fact.id);
  assert.equal(results[0].matched, "words");
  assert.deepEqual(await app.memory.retrieval.search("local", "aardvark"), []);
});

test("a folded conversation keeps a structured summary, and a pinned message stays in front of the model", async (t) => {
  const structured = {
    goals: ["Rename the holiday photos in /pics"],
    decisions: ["Use the date the photo was taken as the name"],
    openQuestions: ["What to do with the three photos that have no date"],
    filesTouched: ["/pics/IMG_0004.jpg"],
  };
  const requests = [];
  const provider = { name: "folding", async complete(request) {
    requests.push(request.messages.map((message) => ({ role: message.role, content: message.content })));
    if (/Summarize the conversation below/.test(request.messages[0].content))
      return { content: JSON.stringify(structured), toolCalls: [] };
    return { content: "Carrying on.", toolCalls: [] };
  } };
  const { app } = await fixture(t, provider);
  // dogfood D22: the room is the model's own now (a hosted one has far more); these conversations are held to the 20,000 they were written for.
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  const first = await app.runtime.run({ prompt: "start renaming photos in /pics" });
  const sessionId = first.sessionId;
  app.store.message(sessionId, { role: "user", content: "The garage door code is 4417 and you will need it later." });
  const pinnable = app.store.workingMessages(sessionId).rows.at(-1);
  app.store.pinMessage("local", sessionId, pinnable.id, true);
  for (let turn = 1; turn <= 40; turn++)
    app.store.message(sessionId, { role: turn % 2 ? "user" : "assistant", content: `Turn ${turn}: ` + "photo renaming details ".repeat(70) });

  const run = await app.runtime.run({ prompt: "what is left to do?", sessionId });
  assert.equal(run.status, "completed");
  const compacted = app.store.events(run.id).find((event) => event.kind === "context.compacted");
  assert.ok(compacted, "the conversation was folded");
  assert.equal(compacted.data.structured, true);
  assert.equal(compacted.data.pinnedKept, 1);

  const saved = app.store.sessionSummary("local", sessionId);
  // The saved summary keeps every part of its shape, an empty list where the model said nothing of that part.
  assert.deepEqual(saved.summary, { ...structured, instructions: [], todos: [] });
  assert.match(saved.text, /What we are trying to do/);
  assert.match(saved.text, /IMG_0004\.jpg/);
  assert.equal(saved.pins.length, 1);
  assert.match(saved.pins[0].content, /4417/);

  const lastRequest = requests.at(-1);
  assert.ok(lastRequest.some((message) => /4417/.test(message.content)), "the pinned message survived the fold");
  assert.ok(!lastRequest.some((message) => /Turn 1:/.test(message.content)), "the ordinary old turns did not");
  assert.ok(app.store.messages(sessionId).some((message) => /Turn 1:/.test(message.content)), "the full transcript is still stored");

  // The next conversation keeps the pin too, and unpinning lets it go.
  app.store.pinMessage("local", sessionId, pinnable.id, false);
  assert.equal(app.store.sessionSummary("local", sessionId).pins.length, 0);
  assert.throws(() => app.store.pinMessage("local", sessionId, 999999, true), /not in this conversation/);
});

test("facts travel as JSON Lines and come back without making a second copy", async (t) => {
  const { app } = await fixture(t);
  const { app: other } = await fixture(t);
  put(app, "Preferred beverage: green tea");
  put(app, "The spare key is under the blue pot");

  const jsonl = app.memory.transfer.export("local");
  assert.equal(jsonl.trim().split("\n").length, 2);
  assert.equal(JSON.parse(jsonl.trim().split("\n")[0]).data.source, "Owner");

  assert.deepEqual(other.memory.transfer.import("local", jsonl), { imported: 2, duplicates: 0, unchanged: 0, skipped: [] });
  assert.deepEqual(texts(other.store.list("memory", "local")), texts(app.store.list("memory", "local")));
  assert.deepEqual(other.memory.transfer.import("local", jsonl), { imported: 0, duplicates: 0, unchanged: 2, skipped: [] });

  // The same fact under a new identifier is recognised and not copied again.
  const renamed = JSON.stringify({ id: "some-other-id", data: { text: "Preferred beverage: green tea", source: "Elsewhere", sourceRunId: "" } });
  const report = other.memory.transfer.import("local", `${renamed}\nnot json at all\n`);
  assert.equal(report.duplicates, 1);
  assert.equal(report.imported, 0);
  assert.deepEqual(report.skipped, [{ line: 2, reason: "This line is not a saved fact" }]);
  assert.equal(other.store.list("memory", "local").length, 2);
});

test("the HTTP routes hand back facts as JSON Lines and a conversation as Markdown", async (t) => {
  const { app, root } = await fixture(t, answering("Done."));
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
  put(app, "The spare key is under the blue pot");
  const run = await app.runtime.run({ prompt: "say hello" });

  const exported = await fetch(`${server.url}/api/memory/export?format=jsonl`, { headers });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type"), /jsonl/);
  const body = await exported.text();
  assert.match(JSON.parse(body.trim()).data.text, /blue pot/);

  const back = await fetch(`${server.url}/api/memory/import`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonl: body }),
  });
  assert.deepEqual((await back.json()).unchanged, 1);

  const markdown = await fetch(`${server.url}/api/sessions/${run.sessionId}/export?format=markdown`, { headers });
  assert.match(markdown.headers.get("content-type"), /markdown/);
  const text = await markdown.text();
  assert.match(text, /## You\n\nsay hello/);
  assert.match(text, /## Assistant\n\nDone\./);

  // The whole-archive export is unchanged for anything that already used it.
  const archive = await (await fetch(`${server.url}/api/memory/export`, { headers })).json();
  assert.equal(archive.format, "branch-agent-memory");
});

test("a picture reaches a model that can see and is refused in plain words by one that cannot", async (t) => {
  const seen = [];
  const vision = { name: "vision-fixture", supportsImages: () => true, async complete(request) {
    seen.push(request.messages.find((message) => message.images?.length));
    return { content: "It is a small red square.", toolCalls: [] };
  } };
  const picture = { mediaType: "image/png", name: "square.png", data: Buffer.from("a tiny stand-in for png bytes").toString("base64") };
  const { app } = await fixture(t, vision);
  const run = await app.runtime.run({ prompt: "what is in this picture?", images: [picture] });
  assert.equal(run.status, "completed");
  assert.match(run.output, /red square/);
  assert.equal(seen[0].images.length, 1);
  assert.equal(seen[0].images[0].data, picture.data);
  assert.equal(seen[0].images[0].mediaType, "image/png");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "images.attached"));
  const stored = app.store.messages(run.sessionId).filter((message) => message.role === "user");
  assert.match(stored[0].content, /\[attached picture: square\.png\]/);
  assert.ok(!stored.some((message) => message.images), "the picture's bytes are never written down");

  const { app: textOnly } = await fixture(t, answering("I only read words."));
  const refused = await textOnly.runtime.run({ prompt: "what is in this picture?", images: [picture] });
  assert.equal(refused.status, "failed");
  assert.match(refused.output, /cannot look at pictures/);
  assert.ok(textOnly.store.events(refused.id).some((event) => event.kind === "images.unsupported"));
});

test("each conversation keeps a line saying what is being worked on", async (t) => {
  let asked = false;
  const provider = { name: "one-tool", async complete() {
    if (asked) return { content: "All done.", toolCalls: [] };
    asked = true;
    return { content: "", toolCalls: [{ id: "call-1", name: "files.write", arguments: '{"path":"notes/holiday.md","content":"hi"}' }] };
  } };
  const { app } = await fixture(t, provider);
  const run = await app.runtime.run({ prompt: "write my holiday notes", permissions: ["files.write"] });
  assert.equal(run.status, "completed");

  const line = app.store.working.line(run.sessionId);
  assert.equal(line.goal, "write my holiday notes");
  assert.equal(line.file, "notes/holiday.md");
  assert.match(line.tool, /Writing/);
  const described = app.store.working.describe(run.sessionId);
  assert.match(described, /Working on: write my holiday notes/);
  assert.match(described, /last file notes\/holiday\.md/);
  assert.equal(app.store.sessionSummary("local", run.sessionId).working.goal, "write my holiday notes");
  assert.equal(app.store.working.describe("no-such-conversation"), "");
});
