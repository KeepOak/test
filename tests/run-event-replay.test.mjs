/**
 * RES-512: an exported event log plays back offline only when it is whole and unchanged, and restarting from it starts
 * a new task through the normal engine only after an explicit yes, never replaying recorded approvals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { runEventLog } from "../dist/run-event-log.js";
import { parseEventReplay } from "../dist/run-event-replay.js";

test("RES-512: a whole, unchanged event log plays back, and a restart needs a yes and makes a new task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-event-replay-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "Say done" });
  const jsonl = runEventLog(app.store, app.runtime.owner, run.id, app.runtime.hideSecrets);
  const played = parseEventReplay(jsonl);
  assert.equal(played.run.id, run.id);
  assert.equal(played.events.length, app.store.events(run.id).length);
  assert.throws(() => parseEventReplay(jsonl.replace('"Say done"', '"Say more"')), /fingerprint/);
  assert.throws(() => parseEventReplay(jsonl.split("\n").slice(0, -2).join("\n") + "\n"), /footer|incomplete/);
  const restart = (body) => fetch(`${server.url}/api/recordings/restart`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  assert.equal((await restart({ jsonl })).status, 400, "no restart without the owner's yes");
  const done = await restart({ confirmed: true, jsonl });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.notEqual(done.body.replay, run.id, "a new task, not the old one");
});
