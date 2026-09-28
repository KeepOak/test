/* models-ui: a long list a searching tool hands back is filtered by the decision model (one on this computer) before the
   task reads it. The task's model gets the lines the decision model kept, the needle among them, and is told how many
   were set aside; the record keeps the tool's whole answer, so the owner still sees every line; Look inside says what
   was kept. With no model on this computer and none chosen apart from the task's, nothing is filtered. Stand-ins only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { notes } from "../dist/inspect.js";
import { discardTemp } from "./temp-dir.mjs";

const NEEDLE = "invoice-2026-0917 from Acme Ltd: 4,120.00 overdue";
const results = Array.from({ length: 100 }, (_, i) => ({ title: i === 63 ? NEEDLE : `newsletter ${i}: weekly offers`, id: i }));

async function fixture(t, { local = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-filter-lists-"));
  const seen = { task: [], decision: [] };
  const task = { name: "scripted", async complete(request) {
    seen.task.push(request.messages);
    const told = request.messages.filter((m) => m.role === "tool");
    if (!told.length) return { content: "", toolCalls: [{ id: "s1", name: "archive.search", arguments: "{}" }] };
    return { content: "done", toolCalls: [] };
  } };
  // A model on this computer (its embeddings route is localhost) keeps the lines that name an invoice, and one more.
  const decider = { name: "openai-compatible", embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1", apiKey: "" }), async complete(request) {
    const asked = request.messages.at(-1).content;
    seen.decision.push(asked);
    const keep = [...asked.matchAll(/^(\d+)\. (.*)$/gm)].filter(([, , line]) => /invoice/i.test(line)).map(([, n]) => Number(n));
    return { content: JSON.stringify({ keep: [...keep, 1], confidence: 0.9 }), toolCalls: [] };
  } };
  const presets = [{ id: "task", name: "Task model", model: "task-1", provider: task },
    ...(local ? [{ id: "here", name: "On this computer", model: "small-1", provider: decider }] : [])];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "task" });
  app.registry.register({ name: "archive.search", permission: "files.read", description: "stand-in mail search",
    parameters: z.object({}).strict(), execute: async () => ({ query: "invoice", results }) });
  return { app, seen };
}

test("a long list is filtered before the task reads it: the needle is kept, the rest is set aside and said", async (t) => {
  const { app, seen } = await fixture(t);
  const run = await app.runtime.run({ prompt: "Find the overdue invoice in my mail", permissions: ["files.read"] });
  assert.equal(run.status, "completed", run.output);
  assert.equal(seen.decision.length, 1, "the decision model was asked once");
  const toolMessage = seen.task.at(-1).find((m) => m.role === "tool");
  const given = JSON.parse(toolMessage.content).result;
  assert.ok(given.results.some((r) => r.title === NEEDLE), "the needle is in what the task read");
  assert.equal(given.results.length, 2, "the task read only what was kept");
  assert.equal(given.setAside.lines, 98);
  assert.match(given.setAside.note, /98 of 100 lines were set aside.*The owner still sees them all/);
  assert.equal(given.query, "invoice", "the rest of the tool's answer is kept");
  // The record keeps the tool's whole answer: nothing is hidden from the owner.
  const completed = app.store.events(run.id).find((e) => e.kind === "tool.completed" && e.data.name === "archive.search");
  assert.equal(completed.data.result.results.length, 100);
  const filtered = app.store.events(run.id).find((e) => e.kind === "list.filtered");
  assert.deepEqual({ ...filtered.data }, { tool: "archive.search", kept: 2, dropped: 98, total: 100, model: "On this computer", local: true });
  assert.deepEqual(notes(app.store, run.id).lists, [{ tool: "archive.search", kept: 2, total: 100, model: "On this computer" }]);
});

test("a short list, the switch off, or no cheap model: the task reads the whole list", async (t) => {
  const { app, seen } = await fixture(t, { local: false });
  const run = await app.runtime.run({ prompt: "Find the overdue invoice", permissions: ["files.read"] });
  assert.equal(run.status, "completed", run.output);
  assert.equal(JSON.parse(seen.task.at(-1).find((m) => m.role === "tool").content).result.results.length, 100, "no model to filter with: whole");
  assert.equal(seen.decision.length, 0);
  assert.equal(app.decisionModels.overview().listModel, null, "the window greys the switch with its reason");
});
