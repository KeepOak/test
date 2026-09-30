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
import { DecisionModels } from "../dist/decision-models.js";
import { runOrigin } from "../dist/key-context.js";
import { CliAgentProvider, rowFor } from "../dist/providers/cli-agent.js";
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

test("a list filter stops with its task and is paid from the task's budget", async (t) => {
  const { app } = await fixture(t);
  // The plumbing: the task's Stop and budget are what the decision is asked with.
  const origin = { signal: new AbortController().signal, budget: { tag: "the task's budget" } };
  let asked = null;
  const decisions = new DecisionModels(app.store, app.runtime.owner, app.runtime.models, async (text, shape, preset, given) => {
    asked = given;
    return { status: "resolved", value: { keep: [1], confidence: 0.9 } };
  });
  await decisions.filterList("find the invoice", results.map((r) => r.title), origin);
  assert.equal(asked, origin, "the decision is asked with the task's own signal and budget");

  // In a task: Stop reaches a filter that is still deciding, rather than it running on for its own minute.
  let aborted = false, deciding;
  const started = new Promise((resolve) => { deciding = resolve; });
  const here = app.runtime.models.presets.get("here");
  here.provider.complete = (request) => new Promise((resolve, reject) => {
    deciding();
    request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }, { once: true });
  });
  const running = app.runtime.run({ prompt: "Find the overdue invoice in my mail", permissions: ["files.read"] });
  await started;
  const id = app.store.runs(app.runtime.owner).find((run) => run.prompt.startsWith("Find the overdue"))?.id;
  assert.ok(id && app.runtime.cancel(id), "the task is stopped");
  const until = Date.now() + 5000;
  while (!aborted && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aborted, true, "the filter's model call was stopped with the task");
  await running.catch(() => undefined);
});

test("a list filter's decision is part of its task: it stays on this computer when the task must, and counts toward its spending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-filter-family-"));
  const seen = { elsewhere: 0, here: 0, family: null };
  const answer = (request) => {
    const keep = [...request.messages.at(-1).content.matchAll(/^(\d+)\. (.*)$/gm)].filter(([, , line]) => /invoice/i.test(line)).map(([, n]) => Number(n));
    return { content: JSON.stringify({ keep, confidence: 0.9 }), toolCalls: [] };
  };
  const task = { name: "scripted", async complete(request) {
    if (!request.messages.some((m) => m.role === "tool")) return { content: "", toolCalls: [{ id: "s1", name: "archive.search", arguments: "{}" }] };
    return { content: "done", toolCalls: [] };
  } };
  let app;
  const here = { name: "openai-compatible", embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1", apiKey: "" }), async complete(request) {
    // The task itself is kept here too once it holds personal details; only the filter's question is counted.
    if (!/Keep every line/.test(request.messages.at(-1).content)) return { content: "done", toolCalls: [] };
    seen.here++;
    const side = app.store.runs(app.runtime.owner).find((run) => run.prompt === "Making a small decision" && run.status === "running");
    const parent = app.store.runs(app.runtime.owner).find((run) => run.prompt.startsWith("Find the overdue"));
    seen.family = side && parent ? app.runtime["spendFamily"](parent.id).includes(side.id) : null;
    return answer(request);
  } };
  const elsewhere = { name: "scripted", async complete(request) { seen.elsewhere++; return answer(request); } };
  app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "task", name: "Task model", model: "task-1", provider: task },
    { id: "here", name: "On this computer", model: "small-1", provider: here },
    { id: "elsewhere", name: "Elsewhere", model: "remote-1", provider: elsewhere }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "task" });
  app.decisionModels.configure({ model: "elsewhere" });
  app.registry.register({ name: "archive.search", permission: "files.read", description: "stand-in mail search",
    parameters: z.object({}).strict(), execute: async () => ({ query: "invoice", results }) });
  // The task has personal details the owner keeps on this computer (as routing marks such a task).
  const filter = app.runtime.listFilter;
  app.runtime.listFilter = (rule, lines, origin) => { app.runtime["staysHere"].add(origin.runId); return filter(rule, lines, origin); };
  const run = await app.runtime.run({ prompt: "Find the overdue invoice in my mail", permissions: ["files.read"] });
  assert.equal(run.status, "completed", run.output);
  assert.equal(seen.elsewhere, 0, "a task kept on this computer never sends its list to a connection elsewhere");
  assert.equal(seen.here, 1, "the model here decided instead");
  assert.equal(seen.family, true, "the decision's run counts toward the task's spending while it runs");
});

test("a list filter's decision answers to its task's asker, with no program tools of its own", async (t) => {
  const { app } = await fixture(t);
  const here = app.runtime.models.presets.get("here");
  const seen = [];
  const decide = here.provider.complete.bind(here.provider);
  here.provider.complete = async (request) => {
    const side = app.store.runs(app.runtime.owner).find((run) => run.prompt === "Making a small decision" && run.status === "running");
    seen.push({ programTools: request.programTools, source: side ? runOrigin(app.store, side.id).source : null });
    return decide(request);
  };
  for (const source of ["schedule", "owner"]) {
    const run = await app.runtime.run({ prompt: "Find the overdue invoice in my mail", permissions: ["files.read"], source });
    assert.equal(run.status, "completed", run.output);
  }
  assert.deepEqual(seen.map((one) => one.source), ["schedule", "owner"], "the decision is asked as its task's own asker");
  assert.deepEqual(seen.map((one) => one.programTools), [false, false], "a tool-free decision never gets a program's own tools");
});

test("a practice task's list filter never reaches an installed coding program: the practice refusal holds for it too", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-filter-practice-"));
  const task = { name: "scripted", async complete(request) {
    if (!request.messages.some((m) => m.role === "tool")) return { content: "", toolCalls: [{ id: "s1", name: "archive.search", arguments: "{}" }] };
    return { content: "done", toolCalls: [] };
  } };
  let spawned = 0;
  const program = new CliAgentProvider(rowFor({ id: "installed", command: "an-installed-assistant" }), { timeoutMs: 5000 },
    async () => { spawned++; return { stdout: JSON.stringify({ keep: [1], confidence: 0.9 }), stderr: "", code: 0 }; });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "task", name: "Task model", model: "task-1", provider: task },
    { id: "installed", name: "Installed assistant", model: "cli-1", provider: program }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "task" });
  app.decisionModels.configure({ model: "installed" });
  app.registry.register({ name: "archive.search", permission: "files.read", description: "stand-in mail search",
    parameters: z.object({}).strict(), execute: async () => ({ query: "invoice", results }) });
  const run = await app.runtime.run({ prompt: "Find the overdue invoice in my mail", permissions: ["files.read"], dryRun: true });
  assert.equal(run.status, "completed", run.output);
  assert.equal(spawned, 0, "the installed program was never started for a practice task's filter");
  const failed = app.store.events(run.id).find((e) => e.kind === "list.filter_failed");
  assert.match(failed?.data.reason ?? "", /Practice cannot use an installed coding assistant/, "the practice refusal is the reason");
});
