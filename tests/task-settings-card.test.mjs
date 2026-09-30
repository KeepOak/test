/**
 * SELF-065: the task-settings card. Typed words suggest only switched-off helpful settings; nothing
 * changes until the owner applies chosen ones, and a preview that went stale is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
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

/* Review of #1157 (P2): the server's App lock check for task-apply ran before the body was read, and nothing asked again
   after it. The body here is held back until that first check has run, Branch is locked, and only then is it sent. */
test("SELF-065: App lock turned on while the apply body is still arriving refuses the change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-task-settings-lock-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  app.store.save("settings", app.runtime.owner, "run-recording", { mode: "off" });
  const request = "Please debug and trace why the export is slow";
  const preview = await fetch(server.url + "/api/settings-kit/task-preview", { method: "POST", headers, body: JSON.stringify({ request }) })
    .then((r) => r.json());
  const pick = preview.changes.find((change) => change.key === "run-recording");
  assert.ok(pick, JSON.stringify(preview));
  // Every ask of the lock from here on is counted, so the body is sent only after the server's first check has run.
  let asked = 0;
  const locked = app.sessionLock.locked.bind(app.sessionLock);
  app.sessionLock.locked = () => { asked++; return locked(); };
  const url = new URL("/api/settings-kit/task-apply", server.url);
  const answer = new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.flushHeaders();
    const waitForCheck = () => {
      if (asked === 0) { setImmediate(waitForCheck); return; }
      app.sessionLock.lock();
      req.end(JSON.stringify({ request, fingerprint: preview.fingerprint, accept: [pick.id] }));
    };
    waitForCheck();
  });
  const { status, text } = await answer;
  assert.equal(status, 423, text);
  assert.equal(app.store.get("settings", app.runtime.owner, "run-recording")?.data?.mode, "off", "locked, yet the setting changed");
});
