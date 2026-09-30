/**
 * Overview: recent activity is what a person asked for. GET /api/state marks `aside` the tasks setup started (#386,
 * src/setup-origin.ts) and the tasks the engine marks as its own where it makes them (Store.markAside: the task that
 * opens a Trunk's conversation, its introduction, reading a schedule; a learning pass and a helper name a parent), and
 * tasks in a temporary conversation. It goes by where a task came from, never by its words: a task asked from the
 * window is not marked, whatever it says.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { learningTask } from "../dist/skill-authoring.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-overview-aside-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello, I am here.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, setup = false) => {
    const response = await fetch(new URL(path, server.url), {
      method, headers: { authorization: `Bearer ${server.token}`, "x-branch-origin": setup ? "setup" : "window",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    assert.ok(response.status < 400, `${method} ${path}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  return { app, call, url: server.url, token: server.token };
}

test("GET /api/state marks setup's tasks and the engine's own asks aside, and nothing the window asked", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" }, true);
  await call("POST", "/api/trunks", { name: "Made in setup" }, true);
  await call("POST", "/api/trunks", { name: "Made later" });
  await app.trunks.introduced();
  await call("POST", "/api/run", { prompt: "Hello from setup" }, true);
  await call("POST", "/api/run", { prompt: "Summarise my week" });
  const runs = (await call("GET", "/api/state")).runs;
  const byPrompt = (words) => runs.filter((r) => r.prompt === words);
  assert.equal(byPrompt("Hello from setup")[0]?.aside, true, "a task asked from setup");
  assert.equal(byPrompt("Summarise my week")[0]?.aside, undefined, "a task asked from the window");
  for (const name of ["Made in setup", "Made later"]) {
    const trunk = app.trunks.records.list().find((one) => one.name === name);
    assert.ok(trunk, `${name} was kept`);
    const opening = app.store.sessionRuns(app.runtime.owner, trunk.chatSessionId)
      .map((run) => app.store.run(run.id)).find((run) => run?.prompt === `Trunk: ${name}`);
    assert.ok(opening, `${name}'s conversation has its saved opening row`);
    assert.equal(app.store.engineOwnRuns([opening.id]).has(opening.id), true, `${name}'s opening is marked aside`);
    assert.equal(byPrompt(`Trunk: ${name}`).length, 0, `${name}'s bookkeeping is hidden from recent activity`);
  }
  const intros = runs.filter((r) => r.prompt.startsWith("Introduce yourself to the owner"));
  assert.equal(intros.length, 2);
  assert.ok(intros.every((r) => r.aside === true), "each Trunk's introduction, from setup or not");
});

test("helpers, temporary conversations, learning passes and reading a schedule are aside too", async (t) => {
  const { app, call, url, token } = await fixture(t);
  const owner = app.runtime.owner, store = app.store;
  const parent = store.createRun(owner, "Plan my trip");
  const helper = store.createRun(owner, "Look up train times");
  store.event(helper.id, "run.started", { provider: "scripted", parentRunId: parent.id });
  const plain = store.createRun(owner, "Write a haiku");
  store.event(plain.id, "run.started", { provider: "scripted", parentRunId: null });
  store.createRun(owner, "Making a small decision", undefined, true, "owner");
  learningTask(store, owner, "from the last week", app.runtime);
  // Reading a schedule is the engine's own ask, made by POST /api/schedules/propose when the words need the model; the
  // scripted model's answer is no schedule, so the route may refuse it, and the task it made is there all the same.
  await fetch(new URL("/api/schedules/propose", url), { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json" }, body: JSON.stringify({ text: "tidy the desk before I leave work", timezone: "UTC" }) });
  const runs = (await call("GET", "/api/state")).runs, aside = (words) => runs.find((r) => r.prompt === words)?.aside;
  assert.equal(aside("Look up train times"), true, "a helper another task started");
  assert.equal(aside("Making a small decision"), true, "a task in a temporary conversation");
  assert.equal(aside("Learning: from the last week"), true, "a learning pass");
  assert.equal(aside("Reading a schedule from your words"), true, "reading a schedule from the owner's words");
  assert.equal(aside("Plan my trip"), undefined, "the task the owner asked for");
  assert.equal(aside("Write a haiku"), undefined, "a task that started with no parent");
});

test("a person's own task is never aside for its words: one that starts \"Learning: \" or reads like the engine's stays", async (t) => {
  const { app, call } = await fixture(t);
  const words = ["Learning: plan my week", "Reading a schedule from your words",
    "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation."];
  for (const prompt of words) await call("POST", "/api/run", { prompt });
  const opened = app.store.createRun(app.runtime.owner, "Say hello");
  app.store.finish(opened.id, "completed", "Opened");
  const runs = (await call("GET", "/api/state")).runs;
  for (const prompt of words) assert.equal(runs.find((r) => r.prompt === prompt)?.aside, undefined, prompt);
  assert.equal(runs.find((r) => r.prompt === "Say hello")?.aside, undefined, "a task whose answer was just \"Opened\"");
});
