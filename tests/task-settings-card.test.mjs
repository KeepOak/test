/**
 * SELF-065: the task-settings card. Typed words suggest only switched-off helpful settings; nothing
 * changes until the owner applies chosen ones, and a preview that went stale is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("SELF-065: a task's words suggest settings; only the chosen ones change, and a stale preview is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-task-settings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(server.url + path, { method: "POST", headers: { authorization: `Bearer ${server.token}`,
    "content-type": "application/json", origin: server.url }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  // Both ship on; the owner switched them off, so the card may suggest them back for this task.
  for (const key of ["run-recording", "event-loop-watch"]) app.store.save("settings", app.runtime.owner, key, { mode: "off" });
  const request = "Please debug and trace why the export is slow";
  const preview = await call("/api/settings-kit/task-preview", { request });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const keys = preview.body.changes.map((change) => change.key);
  assert.ok(keys.includes("run-recording") && keys.includes("event-loop-watch"), JSON.stringify(keys));
  assert.equal((await call("/api/settings-kit/task-preview", { request: "debug this but do not enable anything" })).body.changes.length, 0);
  const pick = preview.body.changes.find((change) => change.key === "run-recording");
  const applied = await call("/api/settings-kit/task-apply", { request, fingerprint: preview.body.fingerprint, accept: [pick.id] });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(app.store.get("settings", app.runtime.owner, "run-recording")?.data?.mode, "when-needed");
  assert.equal(app.store.get("settings", app.runtime.owner, "event-loop-watch")?.data?.mode, "off", "not chosen, not changed");
  const stale = await call("/api/settings-kit/task-apply", { request, fingerprint: preview.body.fingerprint, accept: [pick.id] });
  assert.equal(stale.status, 409);
});
