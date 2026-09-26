import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { chunkText, documentBytesLimit } from "../dist/documents.js";
import { docxText, xlsxText, htmlText, documentType } from "../dist/document-text.js";
import { cosine, fuseRanks } from "../dist/document-embeddings.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-documents-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about documents, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}
const scripted = (extra = {}) => ({
  name: "documents-fixture", requests: [],
  async complete(input) { this.requests.push(input.messages.map((m) => ({ ...m }))); return { content: "Answered.", toolCalls: [] }; },
  ...extra,
});

/** A minimal ZIP container, the way Word and spreadsheet files are packed. */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text, deflated] of entries) {
    const raw = Buffer.from(text, "utf8");
    const body = deflated ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(deflated ? 8 : 0, 10); directory.writeUInt32LE(0, 16);
    directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); central.push(directory, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const docxFixture = () => zip([["word/document.xml",
  "<w:document><w:body><w:p><w:r><w:t>Holiday policy</w:t></w:r></w:p>" +
  "<w:p><w:r><w:t>Staff get twenty days</w:t></w:r><w:tab/><w:r><w:t>each year &amp; more</w:t></w:r></w:p></w:body></w:document>",
  true]]);
const xlsxFixture = () => zip([
  ["xl/sharedStrings.xml", "<sst><si><t>Region</t></si><si><r><t>North</t></r><r><t>ern</t></r></si></sst>", true],
  ["xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>Spend</t></is></c></row>' +
    '<row><c t="s"><v>1</v></c><c><v>4210</v></c></row></sheetData></worksheet>', true],
]);

/** A stand-in embeddings service: two dimensions, "time away" and "money", so meaning differs from wording. */
async function embeddingService(t, behaviour = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const input = JSON.parse(body).input;
      calls.push(input);
      if (behaviour.fail) { response.writeHead(500).end('{"error":"no"}'); return; }
      const data = input.map((text, index) => ({ index, embedding: [
        /holiday|leave|vacation|time off|absence/i.test(text) ? 1 : 0.01,
        /invoice|billing|payment|spend/i.test(text) ? 1 : 0.01,
      ] }));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, endpoint: `http://127.0.0.1:${server.address().port}` };
}
const withEmbeddings = (endpoint) => scripted({ embeddings: () => ({ endpoint, apiKey: "test-key" }) });

test("passages are split with overlap and short text stays whole", () => {
  assert.deepEqual(chunkText("A short note"), ["A short note"]);
  assert.deepEqual(chunkText("   "), []);
  const pieces = chunkText("word ".repeat(2000), 400, 80);
  assert.ok(pieces.length > 5, "long text becomes several passages");
  assert.ok(pieces.every((piece) => piece.length <= 400), "no passage exceeds the size");
  assert.ok(pieces.join(" ").includes("word word"), "the words survive");
});

test("Word, spreadsheet and web files become readable text", () => {
  const word = docxText(docxFixture());
  assert.match(word, /Holiday policy\nStaff get twenty days\teach year & more/);
  const sheet = xlsxText(xlsxFixture());
  assert.match(sheet, /Region\tSpend/, "inline and shared strings are both read");
  assert.match(sheet, /Northern\t4210/, "rich text keeps every run and numbers are kept");
  assert.equal(htmlText("<p>Kept</p><script>var secret = 1;</script><style>p{color:red}</style><p>Also kept</p>"), "Kept\nAlso kept");
  assert.equal(documentType("notes/Report.DOCX"), "docx");
});

test("search ranks the better passage first and highlights the matching words", async (t) => {
  const { app } = await fixture(t);
  assert.equal(app.documents.ranked, true, "this build of SQLite indexes words");
  await app.documents.add("local", { name: "Budget note", text: "The budget is the budget for the team." });
  await app.documents.add("local", { name: "Long memo", text: `Meeting notes. ${"Filler sentence about nothing. ".repeat(40)} The budget was mentioned once.` });
  const results = await app.documents.search("local", { query: "budget" });
  assert.equal(results[0].source, "Budget note", "the shorter, denser passage ranks first");
  assert.equal(results.length, 2);
  assert.match(results[0].highlight, /\[budget\]/, "matching words come back marked for highlighting");
  assert.equal(results[0].matched, "words");
  assert.deepEqual(await app.documents.search("local", { query: "kangaroo" }), []);
});

test("without an embeddings key the library searches words only and says so", async (t) => {
  const { app } = await fixture(t, scripted());
  await app.documents.add("local", { name: "Handbook", text: "Staff may take holiday after three months." });
  assert.equal(app.documents.meaningSearchReady("local"), false);
  assert.equal(app.documents.view("local").meaningSearch, false);
  const [found] = await app.documents.search("local", { query: "holiday" });
  assert.equal(found.matched, "words");
  assert.equal(app.documents.list("local")[0].embedded, 0);
});

test("with an embeddings key meaning and wording are combined, in batches, and a failure still leaves word search", async (t) => {
  const service = await embeddingService(t);
  const { app } = await fixture(t, withEmbeddings(service.endpoint));
  await app.documents.add("local", { name: "Handbook", text: "Staff may take holiday after three months." });
  await app.documents.add("local", { name: "Ledger", text: "Every invoice is paid within thirty days." });
  assert.equal(app.documents.meaningSearchReady("local"), true);
  assert.equal(app.documents.list("local").every((document) => document.embedded === 1), true);
  const results = await app.documents.search("local", { query: "time off" });
  assert.equal(results[0].source, "Handbook", "meaning finds the passage that shares no words with the question");
  assert.equal(results[0].matched, "meaning");
  const both = await app.documents.search("local", { query: "holiday" });
  assert.equal(both[0].matched, "both", "a passage both searches like is combined");

  const many = Array.from({ length: 70 }, (_, index) => `Section ${index}. ${"detail ".repeat(400)}`).join("\n\n");
  service.calls.length = 0;
  const big = await app.documents.add("local", { name: "Manual", text: many });
  assert.ok(big.chunks > 64, "the manual is long enough to need more than one request");
  assert.equal(service.calls.every((call) => call.length <= 64), true, "no request carries more than 64 passages");
  assert.equal(service.calls.length, Math.ceil(big.chunks / 64));

  service.calls.length = 0;
  await app.runtime.executeTool("files.write", { path: "notes.md", content: "Staff may take holiday after one month." });
  const fromFile = await app.runtime.executeTool("documents.add", { path: "notes.md" });
  assert.equal(fromFile.embedded, 1);
  await app.runtime.executeTool("files.write", { path: "notes.md", content: "Staff may take holiday after two months." });
  const after = app.documents.list("local").find((document) => document.id === fromFile.id);
  assert.equal(after.embedded, 0, "a file the assistant rewrites is not re-sent to the provider on every write");
  assert.match(after.note, /Read the file again/);
  assert.match((await app.documents.search("local", { query: "two months" }))[0].text, /two months/, "words are indexed straight away");

  const failing = await embeddingService(t, { fail: true });
  const { app: second } = await fixture(t, withEmbeddings(failing.endpoint));
  const document = await second.documents.add("local", { name: "Handbook", text: "Staff may take holiday after three months." });
  assert.equal(document.status, "indexed");
  assert.equal(document.embedded, 0);
  assert.match(document.note, /Word search works/);
  assert.equal((await second.documents.search("local", { query: "holiday" }))[0].source, "Handbook");
});

test("combining two orders prefers what both searches liked", () => {
  const fused = fuseRanks([["a", "b"], ["b", "c"]]);
  assert.ok(fused.get("b") > fused.get("a"), "the passage both searches found beats one only a single search found");
  assert.ok(fused.get("a") > 0 && fused.get("c") > 0, "a passage only one search found still counts");
  assert.equal(Number(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])).toFixed(3)), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosine(Float32Array.from([1]), Float32Array.from([1, 0])), 0);
});

test("the person's documents reach the model before the task, and the switch turns that off", async (t) => {
  const provider = scripted();
  const { app } = await fixture(t, provider);
  await app.documents.add("local", { name: "Handbook", text: "The holiday policy gives staff twenty days of paid leave each year." });
  const run = await app.runtime.run({ prompt: "What is the holiday policy?", permissions: [] });
  assert.equal(run.status, "completed");
  const system = provider.requests[0].filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(system, /twenty days of paid leave/, "the passage itself is in the context");
  assert.match(system, /Handbook/, "the passage says which document it came from");
  const event = app.store.events(run.id).find((item) => item.kind === "documents.retrieved");
  assert.deepEqual(event.data.sources, ["Handbook"]);

  app.documents.configure("local", { useDocuments: false });
  provider.requests.length = 0;
  const off = await app.runtime.run({ prompt: "What is the holiday policy?", permissions: [] });
  const quiet = provider.requests[0].filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.doesNotMatch(quiet, /twenty days of paid leave/);
  assert.equal(app.store.events(off.id).some((item) => item.kind === "documents.retrieved"), false);
});

test("adding, re-reading and removing a workspace file, with the write tools gated by permission", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "notes/handbook.md"), "# Handbook\n\nThe kitchen closes at six.");
  const added = await app.runtime.executeTool("documents.add", { path: "notes/handbook.md" });
  assert.equal(added.status, "indexed");
  assert.equal(added.name, "handbook.md");
  assert.match((await app.documents.search("local", { query: "kitchen" }))[0].text, /closes at six/);

  await app.runtime.executeTool("files.write", { path: "notes/handbook.md", content: "# Handbook\n\nThe kitchen closes at nine." });
  assert.match((await app.documents.search("local", { query: "kitchen" }))[0].text, /closes at nine/, "a changed file is indexed again");
  assert.deepEqual(await app.documents.search("local", { query: "six" }), [], "the old wording is gone");

  await rm(join(workspace, "notes/handbook.md"));
  const broken = await app.documents.reindex("local", added.id);
  assert.equal(broken.status, "failed");
  assert.match(broken.note, /could not be read/);

  await assert.rejects(app.registry.execute("documents.add", { text: "Denied" },
    app.runtime.context({ permissions: ["documents.read"] })), /Permission denied/);
  await assert.rejects(app.registry.execute("documents.remove", { id: added.id },
    app.runtime.context({ permissions: ["documents.read"] })), /Permission denied/);
  assert.deepEqual(await app.runtime.executeTool("documents.remove", { id: added.id }), { removed: added.id });
  assert.deepEqual(app.documents.list("local"), []);
});

test("a PDF with nothing readable in it says so, and an oversized upload is refused", async (t) => {
  const { app } = await fixture(t);
  // PDFs are read in this build; a file that only claims to be one has no pages to read.
  const pdf = await app.documents.add("local", { name: "Contract.pdf", content: Buffer.from("%PDF-1.7 binary").toString("base64") });
  assert.equal(pdf.status, "failed");
  assert.match(pdf.note, /No pages could be found/);
  assert.equal(pdf.chunks, 0);
  await assert.rejects(
    app.documents.add("local", { name: "Huge.txt", content: Buffer.alloc(documentBytesLimit + 1, 97).toString("base64") }),
    /up to 20 MB/,
  );
  assert.equal(app.documents.list("local").length, 1, "the refused upload is not recorded");
});

test("the documents routes list, add, search, re-read, remove and hold the answering switch", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, options = {}) => {
    const response = await fetch(server.url + path, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers: { authorization: "Bearer " + server.token, ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const empty = await call("/api/documents");
  assert.deepEqual(empty.body.documents, []);
  assert.equal(empty.body.inAnswers, false, "an empty library is not used when answering");
  assert.equal(empty.body.sizeLimit, documentBytesLimit);

  const added = await call("/api/documents", { body: { name: "Notes.docx", content: docxFixture().toString("base64") } });
  assert.equal(added.status, 200);
  assert.equal(added.body.status, "indexed");
  assert.equal((await call("/api/documents")).body.inAnswers, true, "a library with something in it is used by default");
  assert.match((await call("/api/documents/search", { body: { query: "holiday" } })).body.results[0].highlight, /\[Holiday\]/i);

  assert.equal((await call("/api/documents/settings", { body: { useDocuments: false } })).body.useDocuments, false);
  assert.equal((await call("/api/documents/settings")).body.useDocuments, false);
  assert.equal((await call("/api/documents")).body.inAnswers, false);

  const reread = await call("/api/documents/reindex", { body: { id: added.body.id } });
  assert.equal(reread.status, 400, "an uploaded file has nothing on disk to read again");
  assert.match(reread.body.error, /pasted or uploaded/);
  assert.equal((await call(`/api/documents/${added.body.id}`, { method: "DELETE" })).body.removed, added.body.id);
  assert.deepEqual((await call("/api/documents")).body.documents, []);
  assert.equal((await call("/api/documents/nope", { method: "DELETE" })).status, 404);

  const oversized = await call("/api/documents", {
    body: { name: "Huge.txt", content: "data:text/plain;base64," + Buffer.alloc(documentBytesLimit + 1, 97).toString("base64") },
  });
  assert.equal(oversized.status, 400);
  assert.match(oversized.body.error, /up to 20 MB/, "the person is told the actual limit, in MB");
  assert.deepEqual((await call("/api/documents")).body.documents, [], "nothing is recorded for a refused upload");

  // Redesign: the old Documents panel (public/documents.js, <section id="documents">) is replaced by prototype.html's
  // Library › Documents tab (public/app/places/library.js, GET /api/documents), reached from the side list's Library.
  const panel = await fetch(server.url + "/app/places/library.js");
  assert.equal(panel.status, 200, "the Library place, with its Documents tab, is served");
  const place = await panel.text();
  assert.match(place, /api\("documents"\)/, "its Documents tab reads the documents route");
  assert.match(place, /\["documents", t\("nav\.documents"\)/, "the Library has a Documents tab");
  const shell = await (await fetch(server.url + "/app/shell/shell.js")).text();
  assert.match(shell, /\["library", "book", "Library"\]/, "the side list has a way in to the Library");
  const page = await (await fetch(server.url + "/")).text();
  assert.match(page, /src="\/app\/main\.js"/, "the page loads the window that draws them");
});
