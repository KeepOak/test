/**
 * QA retest 2026-09-28 (T1): a Trunk made while Branch had no model yet (the end of setup, a moment before the model it
 * picked was registered) introduced itself with the no-model stand-in, so its first words were "Hello, I am Researcher."
 * under the red "No model yet" line, and it never tried again. The introduction now waits for a model and runs once the
 * first one is set up; with a model it runs at once, as before. Node only: the real dist/, a scripted model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const introducer = { name: "scripted", async complete() { return { content: "Hi, I am your Researcher.", toolCalls: [] }; } };
const settle = async (check) => { for (let i = 0; i < 100; i++) { if (check()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

test("a Trunk made with no model waits, and introduces itself once the first model is set up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-intro-waits-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), presets: [] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.runtime.models.configured, false, "control: no model yet");
  const trunk = app.trunks.create({ name: "Researcher", description: "Reads the web" });
  await app.trunks.introduced();
  const said = () => app.store.messages(trunk.chatSessionId).filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(said(), [], "nothing is said, and no failed task is left in its conversation");
  assert.equal(app.store.runs(app.runtime.owner).filter((r) => r.sessionId === trunk.chatSessionId && r.status === "failed").length, 0);

  app.runtime.models.register({ id: "local", name: "Local", provider: introducer, model: "local-7b" });
  assert.ok(await settle(() => said().length > 0), "it speaks once a model is set up");
  await app.trunks.introduced();
  assert.deepEqual(said(), ["Hi, I am your Researcher."], "in the model's own words, once");

  app.runtime.models.register({ id: "second", name: "Second", provider: introducer, model: "second" });
  await new Promise((r) => setTimeout(r, 100));
  await app.trunks.introduced();
  assert.deepEqual(said(), ["Hi, I am your Researcher."], "a second model does not make it introduce itself again");
});

test("with a model set up, a new Trunk introduces itself at once, as before", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-intro-at-once-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: introducer });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const trunk = app.trunks.create({ name: "Scout", description: "Finds things" });
  await app.trunks.introduced();
  assert.deepEqual(app.store.messages(trunk.chatSessionId).filter((m) => m.role === "assistant").map((m) => m.content), ["Hi, I am your Researcher."]);
});
