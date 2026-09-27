import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs, outOfRoomSentence } from "../dist/index.js";
import { hostedWindowDefault, localWindowDefault, modelWindow, learnWindow, contextOverflow, windowKey } from "../dist/model-context.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { tokenReport } from "../dist/commands/tokens.js";

/* Dogfood D1/D22: every conversation was held to 20,000 tokens whatever model answered, so a couple of web turns filled
   it ("Room left 0%") and the task ended with no reply. The room now comes from the model; a long turn folds its own
   earlier work and carries on; and when nothing more can be made to fit, the task still ends with words. */

const folder = (request) => String(request.messages[0]?.content ?? "");
async function scripted(t, reply) {
  const root = await mkdtemp(join(tmpdir(), "branch-context-room-"));
  await mkdir(join(root, "w"), { recursive: true });
  for (let i = 0; i < 12; i++) await writeFile(join(root, "w", `page${i}.txt`), `page ${i} `.repeat(1500));
  const seen = [];
  const provider = { name: "scripted", async complete(request) { seen.push(request); return reply(request, seen.length); } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, seen };
}
/** Reads twelve big pages one per round, then answers. The fold and the last word are answered as a model would. */
function reader() {
  let reads = 0;
  return (request) => {
    if (folder(request).startsWith("Summarise the work below")) return { content: "Pages read so far: each says its own number.", toolCalls: [] };
    if (folder(request).startsWith("This task has run out of room")) return { content: "Best answer: the pages each say their number.", toolCalls: [] };
    if (reads < 12) { reads++; return { content: "", toolCalls: [{ id: `r${reads}`, name: "files.read", arguments: JSON.stringify({ path: `page${reads - 1}.txt` }) }] }; }
    return { content: "All twelve pages say their own number.", toolCalls: [] };
  };
}
const kinds = (app, run) => app.store.events(run.id).map((event) => event.kind);

test("the room comes from the model: what its service refused, what it reports, else where it runs; the owner's figure wins", async (t) => {
  const { app } = await scripted(t, () => ({ content: "ok", toolCalls: [] }));
  const owner = app.runtime.owner;
  assert.equal(modelWindow(app.store, owner, { id: "cloud" }, false), hostedWindowDefault);
  assert.equal(modelWindow(app.store, owner, { id: "here" }, true), localWindowDefault);
  assert.equal(modelWindow(app.store, owner, { id: "here", contextWindow: 32768 }, true), 32768, "a model on this computer says what it was loaded with");
  assert.equal(learnWindow(app.store, owner, windowKey({ id: "cloud" }), 90000, hostedWindowDefault), 72000, "a request refused as too long teaches a room a fifth under it");
  assert.equal(modelWindow(app.store, owner, { id: "cloud" }, false), 72000);
  assert.equal(learnWindow(app.store, owner, windowKey({ id: "cloud" }), 120000, 72000), 57600, "and only ever lowers it");
  const preset = app.runtime.models.presets.get(app.runtime.models.summary(owner).defaultPreset);
  assert.equal(app.runtime.contextWindowFor(preset), hostedWindowDefault, "the scripted connection is not on this computer");
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: 50000 });
  assert.equal(app.runtime.contextWindowFor(preset), 50000, "the owner's own figure wins");
  assert.equal(contextOverflow(new ProviderHttpError(400, undefined, "context_length_exceeded")), true);
  assert.equal(contextOverflow(new ProviderHttpError(400, undefined, "rate_limit_exceeded")), false);
});

test("a new conversation's Room left is measured against the model's room, not 20,000", async (t) => {
  const { app } = await scripted(t, () => ({ content: "ok", toolCalls: [] }));
  const run = await app.runtime.run({ prompt: "hello" });
  const report = tokenReport(app.runtime, run.sessionId);
  assert.equal(report.limit, hostedWindowDefault);
});

test("one long turn of reading folds its own earlier work and carries on to its answer", async (t) => {
  const { app } = await scripted(t, reader());
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 8000 });
  const run = await app.runtime.run({ prompt: "read all twelve pages and tell me what they say" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "All twelve pages say their own number.");
  assert.ok(kinds(app, run).includes("context.folded_task"), "this task's own work was folded to make room");
  assert.ok(!kinds(app, run).includes("context.out_of_room"));
});

test("a request the service refuses as too long teaches the room, is fitted and asked again", async (t) => {
  let refusedOnce = false;
  const inner = reader();
  const { app } = await scripted(t, (request, n) => {
    if (!refusedOnce && n === 4) { refusedOnce = true; throw new ProviderHttpError(400, undefined, "context_length_exceeded"); }
    return inner(request);
  });
  const run = await app.runtime.run({ prompt: "read all twelve pages and tell me what they say" });
  assert.equal(run.status, "completed", run.output);
  const learned = app.store.events(run.id).find((event) => event.kind === "context.window_learned");
  assert.ok(learned, "the refusal taught the connection's room");
  assert.ok(learned.data.room < hostedWindowDefault);
  const preset = app.runtime.models.presets.get(app.runtime.models.summary(app.runtime.owner).defaultPreset);
  assert.equal(app.runtime.contextWindowFor(preset), learned.data.room, "and it is kept for that connection");
});

test("when nothing more can be made to fit, the task still ends with its best answer and says why", async (t) => {
  const { app } = await scripted(t, reader());
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 8000 });
  const run = await app.runtime.run({ prompt: `Summarise this: ${"word ".repeat(3150)}` });
  assert.equal(run.status, "budget_exceeded");
  assert.ok(run.output.startsWith("Best answer: the pages each say their number."), run.output.slice(0, 200));
  assert.ok(run.output.endsWith(outOfRoomSentence));
  assert.ok(kinds(app, run).includes("context.out_of_room"));
});

test("the window shows a task that stopped at a limit with the engine's words, as it does a failed one", () => {
  const source = readFileSync(new URL("../public/app/chat/runview.js", import.meta.url), "utf8");
  const fn = (name) => new RegExp(`export function ${name}[\\s\\S]*?\\n}\\n`).exec(source)[0].replace("export ", "");
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const failedLine = new Function("esc", `${fn("failedRow")}${fn("failedLine")}; return failedLine;`)(esc);
  const runs = (status) => [{ sessionId: "s", status, output: `${outOfRoomSentence} <b>`, createdAt: "2026-09-27T00:00:00Z" }];
  assert.match(failedLine(runs("budget_exceeded"), "s", false), /I ran out of room in this conversation/);
  assert.match(failedLine(runs("budget_exceeded"), "s", false), /&lt;b&gt;/, "the engine's words are escaped");
  assert.match(failedLine(runs("failed"), "s", false), /I ran out of room/);
  assert.equal(failedLine(runs("completed"), "s", false), "");
  assert.equal(failedLine(runs("budget_exceeded"), "s", true), "", "not while the next message is on its way");
});
