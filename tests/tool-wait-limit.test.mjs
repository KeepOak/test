/**
 * selfdev (SELF-022): a tool that only looks and waits (github.wait_for_checks declares `waitsUpToMs`) may run past the
 * owner's tool time limit, up to its own bound; every other tool is still cut off at the owner's limit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { discardTemp } from "./temp-dir.mjs";

test("a waiting tool may outlast the owner's tool time limit up to its own bound; an ordinary tool may not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wait-limit-"));
  let calls = 0;
  const provider = { name: "scripted", async complete() {
    if (calls === 0) { calls++; return { content: "", toolCalls: [{ id: "w", name: "test.wait_slowly", arguments: "{}" }] }; }
    if (calls === 1) { calls++; return { content: "", toolCalls: [{ id: "o", name: "test.work_slowly", arguments: "{}" }] }; }
    return { content: "done", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: 5 });
  const slow = async (_input, context) => { await delay(6500, undefined, { signal: context.signal }); return { finished: true }; };
  app.registry.register({ name: "test.wait_slowly", permission: "memory.read", description: "waits", parameters: z.object({}).strict(),
    waitsUpToMs: 20_000, execute: slow });
  app.registry.register({ name: "test.work_slowly", permission: "memory.read", description: "works", parameters: z.object({}).strict(), execute: slow });
  const run = await app.runtime.run({ prompt: "wait, then work" });
  const events = app.store.events(run.id);
  const ended = (id) => events.find((event) => ["tool.completed", "tool.failed", "tool.stalled"].includes(event.kind) && event.data.id === id);
  assert.equal(ended("w")?.kind, "tool.completed", "the waiting tool ran its 6.5 seconds past the 5-second limit");
  assert.equal(ended("o")?.kind, "tool.stalled", "an ordinary tool is still cut off at the owner's limit");
  assert.match(ended("o").data.error, /stopped after 5 seconds/);
});
