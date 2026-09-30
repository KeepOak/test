/**
 * RES-512: a finished task's retained events export as JSONL: a header, every event in order, and a footer whose
 * count and SHA-256 cover exactly the lines before it. Exporting runs nothing again, and another owner's task is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { runEventLog } from "../dist/run-event-log.js";

test("RES-512: the event log export holds every retained event and a footer that checks the lines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-event-log-"));
  let calls = 0;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { calls++; return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "Say done" });
  const before = calls;
  const lines = runEventLog(app.store, app.runtime.owner, run.id, (value) => value).trimEnd().split("\n");
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed[0].type, "header");
  assert.equal(parsed[0].run.id, run.id);
  const events = parsed.filter((line) => line.type === "event");
  assert.deepEqual(events.map((line) => line.event.id), app.store.events(run.id).map((event) => event.id));
  const footer = parsed.at(-1);
  assert.equal(footer.type, "footer");
  assert.equal(footer.events, events.length);
  const hash = createHash("sha256");
  for (const line of lines.slice(0, -1)) hash.update(line + "\n");
  assert.equal(footer.sha256, hash.digest("hex"));
  assert.equal(calls, before, "exporting asks no model again");
  assert.throws(() => runEventLog(app.store, "someone-else", run.id, (value) => value), /Task not found/);
});
