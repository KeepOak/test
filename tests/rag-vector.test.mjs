import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Bm25 } from "../dist/bm25.js";
import { chunkDocument, chunkId, markdownSections, paragraphWindows } from "../dist/chunking.js";
import { SqliteVectors, topK } from "../dist/vector-store.js";
import { CachedEmbeddings, EmbeddingCache, asEmbeddings, embeddingConnection, embeddingsFor,
  noEmbeddingsMessage, textFingerprint } from "../dist/embeddings.js";
import { fuseRanks } from "../dist/document-embeddings.js";

/** Two made-up dimensions — "time away" and "money" — so meaning can differ from wording. */
const round = (vector) => [...vector].map((n) => Number(n.toFixed(4)));
const vectorFor = (text) => [
  /holiday|leave|vacation|time off|absence|away/i.test(text) ? 1 : 0.01,
  /invoice|billing|payment|spend|cost/i.test(text) ? 1 : 0.01,
];

/** A stand-in for whichever route a provider offers: OpenAI, Gemini or Ollama, on a loopback port. */
async function fakeProvider(t, shape) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (shape === "openai") {
        calls.push(parsed.input);
        const data = parsed.input.map((text, index) => ({ index, embedding: vectorFor(text) }));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
      } else if (shape === "gemini") {
        const texts = parsed.requests.map((entry) => entry.content.parts[0].text);
        calls.push(texts);
        response.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ embeddings: texts.map((text) => ({ values: vectorFor(text) })) }));
      } else {
        calls.push([parsed.prompt]);
        response.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ embedding: vectorFor(parsed.prompt) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, endpoint: `http://127.0.0.1:${server.address().port}` };
}

const scripted = (answer = "Answered.", extra = {}) => ({
  name: "rag-fixture", requests: [],
  async complete(input) { this.requests.push(input.messages.map((m) => ({ ...m }))); return { content: answer, toolCalls: [] }; },
  ...extra,
});
const withOpenAI = (endpoint, answer) => scripted(answer, { embeddings: () => ({ endpoint, apiKey: "test-key" }) });
const withGemini = (endpoint, answer) =>
  scripted(answer, { images: () => ({ kind: "gemini", endpoint, apiKey: "test-key", defaultModel: "gemini-2.5-flash-image" }) });

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-rag-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace };
}
const handbook = `# Handbook

Welcome to the company handbook.

## Holiday

Staff get twenty days of paid leave each year, taken with a manager's agreement.

## Invoices

Every invoice is paid within thirty days of the date on it.
`;

test("R1 the three provider shapes are each read correctly and a key is required", async (t) => {
  const openai = await fakeProvider(t, "openai");
  const gemini = await fakeProvider(t, "gemini");
  const ollama = await fakeProvider(t, "ollama");
  const signal = AbortSignal.timeout(10000);

  const one = embeddingsFor({ shape: "openai", endpoint: openai.endpoint, apiKey: "k", model: "text-embedding-3-small", local: false });
  assert.deepEqual(round((await one.embed(["a holiday note"], signal))[0]), vectorFor("a holiday note"));
  assert.equal(one.dimensions, 2, "the length of a vector is learned from the first answer");
  assert.equal(one.local, false);

  const two = embeddingsFor({ shape: "gemini", endpoint: gemini.endpoint, apiKey: "k", model: "text-embedding-004", local: false });
  const geminiVectors = await two.embed(["a holiday note", "an invoice"], signal);
  assert.deepEqual(round(geminiVectors[1]), vectorFor("an invoice"));
  assert.deepEqual(gemini.calls, [["a holiday note", "an invoice"]], "Gemini is asked for both passages at once");

  const three = embeddingsFor({ shape: "ollama", endpoint: ollama.endpoint, apiKey: "", model: "nomic-embed-text", local: true });
  assert.deepEqual(round((await three.embed(["time off"], signal))[0]), vectorFor("time off"));
  assert.equal(three.local, true, "a model on this computer is marked as staying here");
  assert.equal(embeddingsFor({ shape: "gemini", endpoint: gemini.endpoint, apiKey: "", model: "m", local: false }), null,
    "without a key nothing is built rather than a request going out unauthenticated");
});

test("R1 which connection reads passages follows the owner's model plan", async (t) => {
  const openai = await fakeProvider(t, "openai");
  const gemini = await fakeProvider(t, "gemini");
  const { app } = await fixture(t, withOpenAI(openai.endpoint));
  assert.equal(embeddingConnection(app.runtime.models, "local").shape, "openai");
  assert.equal(embeddingConnection(app.runtime.models, "local").local, true, "a loopback address is on this computer");

  const { app: second } = await fixture(t, withGemini(gemini.endpoint));
  const chosen = embeddingConnection(second.runtime.models, "local");
  assert.equal(chosen.shape, "gemini");
  assert.equal(chosen.model, "text-embedding-004", "Gemini's own reader is used when none is named");

  const { app: third } = await fixture(t, scripted());
  assert.equal(embeddingConnection(third.runtime.models, "local"), null);
  assert.equal(third.knowledgeBases.meaningSearchReady("local"), false);
  assert.match(noEmbeddingsMessage, /Connect one that offers it/);
});

test("R1 a passage already read is never sent again, and the cost lands on the task", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app } = await fixture(t, withOpenAI(service.endpoint));
  const cache = new EmbeddingCache(app.store.sqlite);
  const adapter = embeddingsFor({ shape: "openai", endpoint: service.endpoint, apiKey: "k", model: "text-embedding-3-small", local: false });
  const reader = new CachedEmbeddings(adapter, cache);
  const signal = AbortSignal.timeout(10000);
  await reader.embed(["holiday policy", "invoice terms"], signal);
  assert.equal(service.calls.length, 1);
  assert.equal(reader.stats.fromProvider, 2);
  await reader.embed(["holiday policy", "invoice terms"], signal);
  assert.equal(service.calls.length, 1, "the second read is answered entirely from what is already kept here");
  assert.equal(reader.stats.fromCache, 2);
  assert.equal(cache.size(), 2);
  assert.equal(textFingerprint("holiday policy", "m"), textFingerprint("holiday policy", "m"));
  assert.notEqual(textFingerprint("holiday policy", "m"), textFingerprint("holiday policy", "other"));

  await writeFile(join(app.files.root, "handbook.md"), handbook, "utf8");
  await app.runtime.executeTool("knowledge.create", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  const done = await app.runtime.executeTool("knowledge.reindex", { collection: "Work" });
  assert.ok(done.embedded > 0, "the collection was compared by meaning");
  const runs = app.store.runs("local").filter((run) => run.prompt.includes("knowledge.reindex"));
  const usage = app.store.usage(runs[0].id);
  assert.ok(usage.estimatedInput > 0, "reading passages is charged to the task that asked for it");
  assert.equal(usage.reportedInput, 0);
});

test("R2 closeness is worked out here, and a hand-computed set comes back in the right order", async (t) => {
  const { app } = await fixture(t);
  const vectors = new SqliteVectors(app.store.sqlite);
  const query = Float32Array.from([1, 0]);
  const hand = topK(query, [
    { id: "same", vector: Float32Array.from([1, 0]) },
    { id: "half", vector: Float32Array.from([1, 1]) },
    { id: "none", vector: Float32Array.from([0, 1]) },
  ], 3);
  assert.deepEqual(hand.map((entry) => entry.id), ["same", "half", "none"]);
  assert.equal(hand[0].score, 1);
  assert.equal(Number(hand[1].score.toFixed(4)), 0.7071, "forty-five degrees apart is the square root of a half");
  assert.equal(hand[2].score, 0);

  await vectors.upsert("local", [
    { collection: "c", docId: "d", chunkId: "same", model: "m", vector: Float32Array.from([1, 0]), textHash: "1" },
    { collection: "c", docId: "d", chunkId: "half", model: "m", vector: Float32Array.from([1, 1]), textHash: "2" },
    { collection: "c", docId: "e", chunkId: "none", model: "m", vector: Float32Array.from([0, 1]), textHash: "3" },
  ]);
  assert.equal(await vectors.count("local", "c"), 3);
  const found = await vectors.search("local", "c", query, 2);
  assert.deepEqual(found.map((match) => match.chunkId), ["same", "half"], "a vector at right angles scores nothing and drops out");
  assert.equal(await vectors.removeDocument("local", "c", "d"), 2);
  assert.equal(await vectors.count("local", "c"), 1);
  assert.equal(await vectors.removeCollection("local", "c"), 1);
});

test("R3 headings are kept, windows overlap, and the same document always gives the same passages", () => {
  const sections = markdownSections(handbook);
  assert.deepEqual(sections.map((section) => section.headingPath), [["Handbook"], ["Handbook", "Holiday"], ["Handbook", "Invoices"]]);
  const chunks = chunkDocument({ key: "handbook.md", title: "handbook.md", text: handbook, markdown: true });
  assert.equal(chunks.length, 3, "one passage per section here, because each section is short");
  assert.deepEqual(chunks[1].headingPath, ["Handbook", "Holiday"]);
  assert.match(chunks[1].text, /Handbook › Holiday/, "the passage carries its own heading path");
  assert.match(chunks[2].text, /thirty days/);
  const again = chunkDocument({ key: "handbook.md", title: "handbook.md", text: handbook, markdown: true });
  assert.deepEqual(again.map((chunk) => chunk.id), chunks.map((chunk) => chunk.id), "the names never vary");
  assert.equal(chunks[0].id, chunkId("handbook.md", 0, chunks[0].text));

  const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${"filler ".repeat(20)}`).join("\n\n");
  const windows = paragraphWindows(paragraphs, 400, 200);
  assert.ok(windows.length > 3, "a long run of paragraphs becomes several windows");
  const overlaps = windows.slice(1).filter((window, index) => {
    const previous = windows[index].split("\n\n").at(-1);
    return window.startsWith(previous);
  });
  assert.equal(overlaps.length, windows.length - 1, "every window after the first repeats the end of the one before");
  const plain = chunkDocument({ key: "notes.txt", title: "notes.txt", text: "Just a line." });
  assert.deepEqual(plain[0].headingPath, []);
  assert.equal(plain[0].page, null);
});

test("R3 a rare word beats a common one, and two searches agreeing beats one", () => {
  const index = new Bm25([
    { id: "rare", text: "The zarquon procedure is reviewed every year by the team." },
    { id: "common", text: "The team reviews the team process with the team every year." },
    { id: "other", text: "Nothing to do with any of this." },
  ]);
  const ranked = index.rank("zarquon team");
  assert.equal(ranked[0].id, "rare", "the passage holding the rare word wins even though the other repeats a common one");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(index.rank("zarquon").map((entry) => entry.id), ["rare"]);
  assert.deepEqual(index.rank("nothing at all here").map((entry) => entry.id), ["other"]);
  assert.deepEqual(index.rank("").map((entry) => entry.id), []);

  const fused = fuseRanks([["both", "words-only"], ["meaning-only", "both"]]);
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  assert.equal(order[0], "both", "what both searches liked is put first");
  assert.ok(fused.get("words-only") > 0 && fused.get("meaning-only") > 0);
});

test("R4 and R3 a folder becomes a searchable knowledge base with citations, and re-reading keeps up", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app, workspace } = await fixture(t, withOpenAI(service.endpoint));
  await mkdir(join(workspace, "company"), { recursive: true });
  await writeFile(join(workspace, "company", "handbook.md"), handbook, "utf8");
  await writeFile(join(workspace, "company", "ledger.txt"), "Every invoice is paid within thirty days.", "utf8");
  await writeFile(join(workspace, "company", "picture.png"), "not text", "utf8");

  const made = app.knowledgeBases.create("local", { name: "Company", sources: [{ kind: "folder", path: "company" }] });
  assert.equal(made.chunks, 0);
  const seen = [];
  const progress = await app.knowledgeBases.reindex("local", made.id, (step) => seen.push({ ...step }));
  assert.ok(seen.length >= 2, "progress is reported as it goes, not only at the end");
  assert.equal(seen.at(-1).finished, true);
  assert.equal(progress.files, 2, "only files the existing readers understand are read");
  assert.ok(progress.chunks >= 4);
  assert.ok(progress.embedded > 0);

  const results = await app.knowledgeBases.search("local", { collection: made.id, query: "how much paid leave do staff get" });
  assert.equal(results[0].documentName, "handbook.md");
  assert.match(results[0].text, /twenty days/);
  assert.equal(results[0].heading, "Handbook › Holiday", "the answer says which heading it came from");
  assert.equal(results[0].documentId, "company/handbook.md");
  assert.ok(["meaning", "both"].includes(results[0].matched));

  await writeFile(join(workspace, "company", "handbook.md"), handbook.replace("twenty days", "twenty-five days"), "utf8");
  await app.knowledgeBases.reindex("local", made.id);
  const after = await app.knowledgeBases.search("local", { collection: made.id, query: "paid leave each year" });
  assert.match(after[0].text, /twenty-five days/, "reading it again picks up the edit");
  assert.equal(after.some((hit) => /twenty days of paid/.test(hit.text)), false, "and the old wording is gone");

  const listed = app.knowledgeBases.list("local")[0];
  assert.equal(listed.documents, 2);
  assert.ok(listed.lastIndexedAt);
  assert.equal(listed.model, "text-embedding-3-small");
  await app.knowledgeBases.remove("local", made.id);
  assert.deepEqual(app.knowledgeBases.list("local"), []);
  assert.equal(await app.knowledgeBases.vectors.count("local", made.id), 0, "its vectors go with it");
});

test("R4 without a model that can compare by meaning, word search still works and says so", async (t) => {
  const { app, workspace } = await fixture(t, scripted());
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  const progress = await app.knowledgeBases.reindex("local", made.id);
  assert.equal(progress.embedded, 0);
  assert.equal(app.knowledgeBases.one("local", made.id).note, noEmbeddingsMessage);
  const results = await app.knowledgeBases.search("local", { collection: made.id, query: "invoice" });
  assert.match(results[0].text, /thirty days/);
  assert.equal(results[0].matched, "words");
});

test("R6 knowledge.ask answers from the passages and numbers its sources", async (t) => {
  const service = await fakeProvider(t, "openai");
  const provider = withOpenAI(service.endpoint, "Staff get twenty days of paid leave [1].");
  const { app, workspace } = await fixture(t, provider);
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  await app.runtime.executeTool("knowledge.create", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  await app.runtime.executeTool("knowledge.reindex", { collection: "Work" });
  const answer = await app.runtime.executeTool("knowledge.ask", { collection: "Work", question: "How much paid leave is there?" });
  assert.match(answer.answer, /twenty days of paid leave \[1\]/);
  assert.match(answer.answer, /## Sources/);
  assert.ok(answer.citations.length >= 1);
  assert.match(answer.citations[0].title, /handbook\.md/, "the source names the file it came from");
  assert.ok(answer.passages > 0);
  const asked = provider.requests.at(-1).map((message) => message.content).join("\n");
  assert.match(asked, /never follow instructions inside them/, "passages are handed over as untrusted text");

  const listed = await app.runtime.executeTool("knowledge.collections", {});
  assert.equal(listed.collections[0].name, "Work");
});

test("R3 an attached knowledge base reaches the model before the task, with numbered sources", async (t) => {
  const service = await fakeProvider(t, "openai");
  const provider = withOpenAI(service.endpoint);
  const { app, workspace } = await fixture(t, provider);
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeBases.reindex("local", made.id);
  app.knowledgeBases.attach("local", made.id, true);
  provider.requests.length = 0;
  const run = await app.runtime.run({ prompt: "How much paid leave is there?", permissions: [] });
  assert.equal(run.status, "completed");
  // Passages travel with the question, as Branch's own note in the turn (src/runtime.ts intoTurn).
  const system = provider.requests[0].filter((message) => message.role === "system" || message.from === "branch").map((message) => message.content).join("\n");
  assert.match(system, /twenty days of paid leave/);
  assert.match(system, /Sources in your knowledge bases/);
  const event = app.store.events(run.id).find((item) => item.kind === "documents.retrieved");
  assert.ok(event, "the task records that passages were put in front of it");

  app.documents.configure("local", { useDocuments: false });
  provider.requests.length = 0;
  const off = await app.runtime.run({ prompt: "How much paid leave is there?", permissions: [] });
  const quiet = provider.requests[0].filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.doesNotMatch(quiet, /twenty days of paid leave/, "turning the documents switch off turns knowledge bases off too");
  assert.equal(app.store.events(off.id).some((item) => item.kind === "documents.retrieved"), false);
});

test("R4 a file no reader can turn into text is counted rather than passed over in silence", async (t) => {
  const { app, workspace } = await fixture(t, scripted());
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  await writeFile(join(workspace, "empty.txt"), "   ", "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  const progress = await app.knowledgeBases.reindex("local", made.id);
  assert.equal(progress.files, 2);
  assert.match(progress.status, /1 file could not be read/);
  assert.equal(app.knowledgeBases.one("local", made.id).documents, 1);
});

test("R5 a paraphrase the words miss is found by meaning, through the shared store of readings", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app } = await fixture(t, withOpenAI(service.endpoint));
  app.store.save("memory", "local", "fact-holiday", { text: "Staff may take holiday after three months." });
  app.store.save("memory", "local", "fact-money", { text: "Every invoice is paid within thirty days." });
  const indexed = await app.memory.retrieval.index("local");
  assert.equal(indexed.embedded, 2);

  const wordsOnly = await app.store.searchMemory("local", "time away");
  assert.equal(wordsOnly.length, 0, "plain word search finds nothing for a paraphrase");
  const hits = await app.memory.retrieval.search("local", "time away");
  assert.equal(hits[0].record.id, "fact-holiday", "meaning finds the fact that shares no words with the question");
  assert.equal(hits[0].matched, "meaning");

  const before = service.calls.length;
  await app.memory.retrieval.index("local");
  assert.equal(service.calls.length, before, "nothing that has not changed is read again");
});

test("R5 the nightly pass suggests a merge and never deletes a fact", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app } = await fixture(t, withOpenAI(service.endpoint));
  app.store.save("memory", "local", "fact-one", { text: "Staff may take holiday after three months." });
  app.store.save("memory", "local", "fact-two", { text: "Time off becomes available once three months have gone by." });
  assert.equal(app.consolidation.due("local"), true, "a pass that has never run is due");

  const result = await app.consolidation.run("local");
  assert.equal(result.embedded, 2);
  assert.equal(result.proposed, 1, "the two ways of saying the same thing are offered as one merge");
  assert.equal(result.deleted, 0);
  assert.equal(app.store.list("memory", "local").length, 2, "both facts are still there");
  const pending = app.store.review.proposals("local", "pending");
  assert.equal(pending.filter((entry) => entry.kind === "merge").length, 1);
  assert.match(pending.find((entry) => entry.kind === "merge").note, /same meaning/);
  assert.equal(app.consolidation.due("local"), false, "and it does not run again the same day");
  assert.equal(await app.consolidation.tick("local"), null);
});

test("R2 and R8 the vector table, the cache and the reader all live in the app's own database", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app } = await fixture(t, withOpenAI(service.endpoint));
  const tables = app.store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
  for (const table of ["vectors", "embedding_cache", "kb_collections", "kb_chunks"])
    assert.ok(tables.includes(table), `${table} is created with the rest of the database`);
  assert.equal(app.knowledgeBases.vectors.name, "this computer");
  const plain = asEmbeddings({ model: "m", embed: async () => [Float32Array.from([1, 0])] });
  assert.equal(plain.local, false);
  assert.equal(plain.model, "m");
});

test("R4 the panel's routes create, read, search and remove a knowledge base", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const service = await fakeProvider(t, "openai");
  const { app, root, workspace } = await fixture(t, withOpenAI(service.endpoint));
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers: { origin: server.url, authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await api("POST", "/api/knowledge", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  assert.equal(created.status, 200);
  assert.equal((await api("POST", "/api/knowledge/reindex", { collection: "Work" })).body.finished, true);
  const view = await api("GET", "/api/knowledge");
  assert.equal(view.body.collections[0].name, "Work");
  assert.equal(view.body.meaningSearch, true);
  assert.equal(view.body.backend, "this computer");
  const found = await api("POST", "/api/knowledge/search", { query: "paid leave" });
  assert.match(found.body.results[0].text, /twenty days/);
  assert.equal((await api("POST", "/api/knowledge/attach", { collection: "Work", attached: true })).body.attached, true);
  assert.equal((await api("POST", "/api/knowledge/settings", { maxIndexTokens: 1000 })).body.maxIndexTokens, 1000);
  assert.equal((await api("GET", "/api/knowledge")).body.limits.maxIndexTokens, 1000);
  assert.equal((await api("DELETE", `/api/knowledge/${created.body.id}`)).body.removed, created.body.id);
  assert.equal((await api("POST", "/api/knowledge/reindex", { collection: "Work" })).status, 400);
});

test("R7 a secret file in the folder is never cut into passages or sent anywhere", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app, workspace } = await fixture(t, withOpenAI(service.endpoint));
  await mkdir(join(workspace, "company"), { recursive: true });
  await writeFile(join(workspace, "company", "handbook.md"), handbook, "utf8");
  await writeFile(join(workspace, "company", ".env"), "OPENAI_API_KEY=sk-super-secret-value\n", "utf8");
  await writeFile(join(workspace, "company", "credentials.json"), '{"token":"sk-also-secret"}', "utf8");
  await writeFile(join(workspace, "company", "id_rsa"), "-----BEGIN PRIVATE KEY-----secret", "utf8");  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  await writeFile(join(workspace, "company", "server.pem"), "-----BEGIN CERTIFICATE-----secret", "utf8");

  // A folder holding secrets, and the same secrets named one by one, must both come to nothing.
  const made = app.knowledgeBases.create("local", { name: "Company", sources: [{ kind: "folder", path: "company" }] });
  for (const path of ["company/.env", "company/credentials.json", "company/id_rsa", "company/server.pem"])
    app.knowledgeBases.addSource("local", made.id, { kind: "file", path });
  await app.knowledgeBases.reindex("local", made.id);

  const stored = app.store.sqlite.prepare("SELECT doc_id, chunk_text FROM kb_chunks WHERE owner='local'").all();
  assert.equal(stored.length > 0, true, "the handbook itself is read");
  for (const row of stored) {
    assert.equal(/\.env|credentials|id_rsa|\.pem/.test(String(row.doc_id)), false, `${row.doc_id} must not be read`);
    assert.equal(/secret|PRIVATE KEY/.test(String(row.chunk_text)), false, "no secret wording is kept as a passage");
  }
  const sent = JSON.stringify(service.calls);
  assert.equal(/sk-super-secret-value|sk-also-secret|PRIVATE KEY/.test(sent), false, "and none of it reaches the provider");
  assert.match(app.knowledgeBases.one("local", made.id).note, /could not be read/);
});

test("R7 a reading that would cost more than the owner allowed is refused in one sentence", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app, workspace } = await fixture(t, withOpenAI(service.endpoint));
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });

  assert.deepEqual(app.knowledgeBases.configure("local", { maxIndexTokens: 5 }), { maxIndexTokens: 5, compareAtMost: 50000 });
  const refused = await app.knowledgeBases.reindex("local", made.id);
  assert.equal(refused.embedded, 0);
  assert.equal(refused.tokens, 0);
  assert.match(refused.status, /about .* units of text/);
  assert.match(refused.status, /raise the limit/i);
  assert.equal(service.calls.length, 0, "nothing was sent while the limit stood");
  assert.match((await app.knowledgeBases.search("local", { collection: made.id, query: "paid leave" }))[0].text,
    /twenty days/, "and word search still answers");

  app.knowledgeBases.configure("local", { maxIndexTokens: 400000 });
  const allowed = await app.knowledgeBases.reindex("local", made.id);
  assert.ok(allowed.embedded > 0);
  assert.ok(allowed.tokens > 0, "what the reading cost is written down");
  assert.equal(app.knowledgeBases.one("local", made.id).indexTokens, allowed.tokens, "and added to the total");

  // Already-read passages cost nothing, so a tight limit must not block a second reading of them.
  const sentSoFar = service.calls.length;
  app.knowledgeBases.configure("local", { maxIndexTokens: 5 });
  const again = await app.knowledgeBases.reindex("local", made.id);
  assert.ok(again.embedded > 0, "re-reading what is already read is never refused");
  assert.equal(again.tokens, 0);
  assert.equal(service.calls.length, sentSoFar, "because nothing had to be sent");
});

test("R5 the second night sends nothing: the facts of the first night are already read", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app } = await fixture(t, withOpenAI(service.endpoint));
  app.store.save("memory", "local", "fact-one", { text: "Staff may take holiday after three months." });
  app.store.save("memory", "local", "fact-two", { text: "Every invoice is paid within thirty days." });

  const first = await app.consolidation.run("local");
  assert.equal(first.embedded, 2);
  assert.ok(service.calls.length > 0, "the first pass does send the new facts once");
  const afterFirst = service.calls.length;

  const second = await app.consolidation.run("local", new Date(Date.now() + 25 * 3600 * 1000));
  assert.equal(service.calls.length, afterFirst, "the second pass sends nothing at all");
  assert.equal(second.deleted, 0);
  assert.equal(app.store.list("memory", "local").length, 2, "and both facts are still there");
});

test("R7 a backup carries the knowledge bases themselves, and their passages are rebuilt", async (t) => {
  const service = await fakeProvider(t, "openai");
  const { app, workspace } = await fixture(t, withOpenAI(service.endpoint));
  await writeFile(join(workspace, "handbook.md"), handbook, "utf8");
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeBases.reindex("local", made.id);
  app.knowledgeBases.attach("local", made.id, true);

  const archive = app.store.backup("test");
  assert.equal(archive.tables.kb_collections.length, 1, "the knowledge base is in the backup");
  assert.equal(archive.tables.kb_collections[0].name, "Work");
  assert.equal(archive.tables.kb_collections[0].attached, 1);
  for (const derived of ["kb_chunks", "vectors", "embedding_cache"])
    assert.equal(archive.tables[derived], undefined, `${derived} is rebuilt from your files, not backed up`);
});
