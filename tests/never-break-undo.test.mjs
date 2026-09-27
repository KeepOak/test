/**
 * Undo an accepted gateway change (POST /api/never-break/rollback): the owner rolls back the last change
 * they accepted from the journal kept beside the gateway's settings. Only timings go back; the owner's
 * switch and the engine's settings stay as they are now. Temporary folders and a fake dry run only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { proposeConfig, loadGatewayConfig, saveGatewayConfig, changesFile } from "../dist/never-break/gateway-config.js";
import { gatewayDataFiles } from "../dist/never-break/protected.js";

const cleanTry = async () => ({ ok: true, detail: "A throwaway gateway started its engine with these settings." });

test("an accepted change is journalled, rolled back once to the timings before it, and a later change is never undone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-never-break-undo-"));
  const dataDir = join(root, "data");
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call("/api/never-break")).body.accepted, null);
  assert.equal((await call("/api/never-break/rollback", {})).status, 409, "nothing accepted, nothing to roll back");

  await proposeConfig(dataDir, { startSeconds: 30, holdSeconds: 5 }, "Wait longer before deciding the engine is stuck", cleanTry);
  assert.equal((await call("/api/never-break/proposal/accept", {})).status, 200);
  await call("/api/never-break", { mode: "on" });
  const view = (await call("/api/never-break")).body;
  assert.deepEqual([view.accepted.before.startSeconds, view.accepted.after.startSeconds, view.accepted.why, view.accepted.rolledBackAt],
    [90, 30, "Wait longer before deciding the engine is stuck", null]);
  assert.equal("workerEnv" in view.accepted.after || "mode" in view.accepted.after, false, "only timings are journalled");

  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("/api/never-break/rollback", {}, key)).status, 401);
  assert.equal((await call("/api/never-break/rollback", { force: true })).status, 400, "the body is strict");
  const back = await call("/api/never-break/rollback", {});
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.match(back.body.note, /^Rolled back\./);
  const config = (await loadGatewayConfig(dataDir)).config;
  assert.deepEqual([config.startSeconds, config.holdSeconds, config.mode], [90, 20, "on"], "timings back, the owner's switch kept");
  assert.ok(back.body.accepted.rolledBackAt);
  const again = await call("/api/never-break/rollback", {});
  assert.deepEqual([again.status, again.body.error], [409, "There is no accepted change to roll back."], "one roll back per accepted change");

  await proposeConfig(dataDir, { watchSeconds: 60 }, "Watch a new version for a minute", cleanTry);
  await call("/api/never-break/proposal/accept", {});
  await proposeConfig(dataDir, { watchSeconds: 120 }, "Watch for two minutes", cleanTry);
  await call("/api/never-break/proposal/accept", {});
  const journal = JSON.parse(await readFile(join(dataDir, changesFile), "utf8"));
  assert.equal(journal.length, 3);
  const { config: current } = await loadGatewayConfig(dataDir);
  await saveGatewayConfig(dataDir, { ...current, gapSeconds: 600 });
  const later = await call("/api/never-break/rollback", {});
  assert.equal(later.status, 409);
  assert.match(later.body.error, /changed after that change was accepted/);
  assert.equal((await loadGatewayConfig(dataDir)).config.watchSeconds, 120, "a change made since is never undone");
  assert.ok(gatewayDataFiles.includes(changesFile), "the assistant's file tools may not write the journal");
});
