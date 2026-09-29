import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveComfort, updatePlan } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * PLAT-148 (TST-013): Lockdown holds on every surface that reaches past this app by itself, checked together in one
 * place after turning it on the way the window does: the phone door, lending this computer to another Branch, an
 * update that would install by itself, and a command a task asks to run. The chat app's owner commands are held in
 * tests/chat-owner-commands.test.mjs ("the exact command Yes refuses Lockdown").
 */
test("with Lockdown on, the phone door, lending this computer, a self-installing update and every tool all hold", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-lockdown-surfaces-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, origin: server.url,
      "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  saveComfort(app.store, app.runtime.owner, "notify", { autoUpdate: "install" });
  const ready = { busyTasks: 0, updaterPhase: "available", updaterTag: "v9.9.9" };
  assert.equal(updatePlan(app.store, app.runtime.owner, ready).step, "install", "control: without Lockdown it installs");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);

  const door = await call("POST", "/api/deployment/remote", { enabled: true });
  assert.equal(door.status, 409, JSON.stringify(door.body));
  assert.match(door.body.error, /Lockdown/);
  if ((await call("GET", "/api/devices/join")).status === 200) {
    const lend = await call("POST", "/api/devices/join/find", {});
    assert.equal(lend.status, 409, JSON.stringify(lend.body));
    assert.match(lend.body.error, /Lockdown is on/);
  }
  const held = updatePlan(app.store, app.runtime.owner, ready);
  assert.equal(held.step, "nothing");
  assert.match(held.reason, /Lockdown/);
  // Every other tool waits for the owner (commands themselves are refused: tests/manual-actions-gate.test.mjs).
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt", content: "x" }, app.runtime.context()).decision, "ask");

  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(updatePlan(app.store, app.runtime.owner, ready).step, "install", "and it installs again once Lockdown is off");
});
