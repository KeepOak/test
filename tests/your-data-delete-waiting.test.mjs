/**
 * QA retest 2026-09-28 (D1): "Delete everything" was refused with "A task is still working. Stop it or wait for it" while
 * the only task was waiting for the owner's answer and the status bar said nothing was running. Waiting still holds the
 * delete (nothing is deleted under a question), but the refusal now says it is a question to answer, and where; a task
 * really running keeps its own words. Node only: the real dist/, a scripted model, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  return last?.role === "user"
    ? { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "hi" }) }] }
    : { content: "Done.", toolCalls: [] };
} };

test("a delete held by a task waiting for an answer says so; one held by a running task says that", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-delete-waiting-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const remove = async () => {
    const response = await fetch(`${server.url}/api/your-data/delete`, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ confirm: "delete everything" }) });
    return { status: response.status, body: await response.json() };
  };
  const waiting = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(waiting.status, "needs_input", "control: the task waits on the owner's question");
  const held = await remove();
  assert.equal(held.status, 409);
  assert.match(held.body.error, /waiting for your answer/);
  assert.match(held.body.error, /Inbox/);
  assert.doesNotMatch(held.body.error, /still working/);
  assert.match(held.body.error, /Nothing was deleted/);

  const running = app.store.createRun(app.runtime.owner, "a long job");
  assert.equal(app.store.run(running.id).status, "running", "control: a task that is really running");
  const busy = await remove();
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /A task is still working/);
  assert.ok(app.store.runs(app.runtime.owner).length >= 2, "nothing was deleted");
});
