/**
 * P17-D §9: the computers a Trunk may use, and how many tasks it may run at once (src/trunks/computers.ts).
 *
 * - Nothing saved: every computer is allowed and there is no limit, as before.
 * - Only the owner's route changes it, only this computer and paired computers may be named, "at once" is never more
 *   than the list, and every change is in the activity log.
 * - Without "this", the Trunk's turns lose the desktop tools. A paired computer not on the list is out of sight of the
 *   device tools (also for work the Trunk set going), refused by name, and cannot be picked for its conversation.
 * - With nothing picked, a Trunk's conversation starts on the first computer on its list.
 * - "At once" refuses one more task than the owner allowed, in words, before it starts.
 *
 * Mutation notes (each turns this file red):
 * - src/trunks/index.ts shapeOf: drop the `desktop.` filter  -> "desktop tools are taken away" fails.
 * - src/devices/tools.ts allowedHere: return true             -> "the device tools see only allowed computers" fails.
 * - src/devices/tools.ts chooseDevice: drop the `first` fallback -> "starts on the first computer" fails.
 * - src/devices/api.ts pick: drop the computerRule check       -> the 403 on picking a computer it may not use fails.
 * - src/runtime.ts execute: drop the trunkAtOnce refusal        -> "a second task at once is refused" fails.
 * - src/trunks/computers.ts set: drop the atOnce bound          -> the 400 for "at once" above the list fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { useDevice, visibleDevices, trunkComputerRefusal } from "../dist/devices/tools.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { brain, on } from "./trunks-helpers.mjs";

const tower = "a1b2c3d4e5f60718", laptop = "0f1e2d3c4b5a6978", phone = "1234567890abcdef";
const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z",
  lastSeen: null, offers: [], enabled: ["notify"], folder: null, sharedWith: [] });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-p17d-computers-"));
  const held = [];
  const provider = brain([({ last }) => (/wait here/.test(last?.content ?? "") ? new Promise((resolve) => held.push(() => resolve({ content: "Let go.", toolCalls: [] }))) : null)]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { for (const release of held) release(); await app.close(); await discardTemp(root); });
  on(app, "conversations");
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [],
    devices: [device(tower, "Tower", "linux"), device(laptop, "Laptop", "darwin"), device(phone, "Phone", "ios")] });
  const scout = app.trunks.create({ name: "Scout", title: "", description: "" });
  await app.trunks.introduced();
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  return { app, scout, held, ask };
}
const contextFor = (app, extra = {}) => {
  const run = app.store.createRun(app.runtime.owner, "device test");
  return { owner: app.runtime.owner, workspace: app.runtime.workspace, runId: run.id, signal: new AbortController().signal,
    budget: { step() {} }, permissions: new Set(), depth: 0, ...extra };
};
const toolDeps = (app, calls) => ({ store: app.store, owner: app.runtime.owner, book: app.devices.book, files: { base: app.runtime.workspace },
  rule: () => app.devices.computerRule,
  hub: { connected: () => true, invoke: async (id) => { calls.push(id); return { value: { done: "shown" } }; } } });
const until = async (check) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(check()); };

test("the route: nothing saved allows everything; the owner's list is checked, bounded and logged", async (t) => {
  const { app, scout, ask } = await fixture(t);
  const fresh = await ask(`/api/trunks/${scout.id}/computers`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.limited, false);
  assert.deepEqual(fresh.body.allowed, ["this", tower, laptop], "every computer, and never the phone");
  assert.equal(fresh.body.atOnce, null, "no limit until the owner sets one");
  assert.deepEqual(fresh.body.computers.map((c) => c.id), ["this", tower, laptop]);

  const stranger = await ask(`/api/trunks/${scout.id}/computers`, { allowed: ["this", phone], atOnce: null });
  assert.equal(stranger.status, 400, "a phone is not a computer");
  assert.match(stranger.body.error, /not one of yours/);
  const tooMany = await ask(`/api/trunks/${scout.id}/computers`, { allowed: [tower, "this"], atOnce: 3 });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /At once can't be more than the computers it may use/);
  assert.equal((await ask(`/api/trunks/${scout.id}/computers`)).body.limited, false, "nothing was saved by a refusal");
  // The generic edit never carries it.
  assert.equal((await ask(`/api/trunks/${scout.id}`, { computers: [tower] })).status, 400);

  const saved = await ask(`/api/trunks/${scout.id}/computers`, { allowed: [tower, "this"], atOnce: 2 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.limited, saved.body.allowed, saved.body.atOnce], [true, [tower, "this"], 2]);
  const log = (await ask("/api/audit")).body;
  assert.ok((log.entries ?? log).some((entry) => entry.action === "trunk.computers" && /Scout/.test(entry.subject)), "written in the activity log");

  // Unpairing a computer takes it off the list, and "at once" follows the shorter list down.
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [], devices: [device(laptop, "Laptop", "darwin")] });
  const after = (await ask(`/api/trunks/${scout.id}/computers`)).body;
  assert.deepEqual([after.allowed, after.atOnce], [["this"], 1]);
});

test("without This computer, desktop tools are taken away from the Trunk's turns", async (t) => {
  const { app, scout, ask } = await fixture(t);
  assert.ok(app.runtime.trunkPermissionsFor(scout.id).includes("desktop.view"), "allowed while nothing is saved");
  await ask(`/api/trunks/${scout.id}/computers`, { allowed: [tower], atOnce: null });
  const now = app.runtime.trunkPermissionsFor(scout.id);
  assert.deepEqual(now.filter((p) => p.startsWith("desktop.")), [], "no screen, mouse or clipboard of this PC");
  assert.ok(now.includes("files.read"), "everything else stays");
  await ask(`/api/trunks/${scout.id}/computers`, { allowed: ["this"], atOnce: null });
  assert.ok(app.runtime.trunkPermissionsFor(scout.id).includes("desktop.control"));
});

test("the device tools see only allowed computers, for the Trunk and for work it set going; phones are not computers", async (t) => {
  const { app, scout, ask } = await fixture(t);
  const calls = [], deps = toolDeps(app, calls);
  await ask(`/api/trunks/${scout.id}/computers`, { allowed: ["this", tower], atOnce: null });
  const names = (context) => visibleDevices(deps, context).map((d) => d.name).sort();
  assert.deepEqual(names(contextFor(app, { trunk: scout.id })), ["Phone", "Tower"]);
  assert.deepEqual(names(contextFor(app)), ["Laptop", "Phone", "Tower"], "the owner's own assistant is not limited");
  // Work the Trunk set going (a helper, a flow) runs marked as the Trunk's, without its own context.trunk.
  const marked = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: scout.keys, id: scout.id } },
    async () => names(contextFor(app)));
  assert.deepEqual(marked, ["Phone", "Tower"]);
  await assert.rejects(useDevice(deps, contextFor(app, { trunk: scout.id }), "Laptop", "notify", { title: "Hi" }), { message: trunkComputerRefusal });
  assert.deepEqual(calls, [], "nothing reached the laptop");
  await useDevice(deps, contextFor(app, { trunk: scout.id }), "Tower", "notify", { title: "Hi" });
  assert.deepEqual(calls, [tower]);
});

test("a Trunk's conversation starts on the first computer on its list, and may pick only one it may use", async (t) => {
  const { app, scout, ask } = await fixture(t);
  const calls = [], deps = toolDeps(app, calls);
  await ask(`/api/trunks/${scout.id}/computers`, { allowed: [laptop, tower], atOnce: 2 });
  const context = contextFor(app, { trunk: scout.id });
  const sessionId = app.store.run(context.runId).sessionId;
  // Laptop and Tower are both connected, so without the list's first choice this would be "Several devices".
  await useDevice(deps, context, undefined, "notify", { title: "Hi" });
  assert.deepEqual(calls, [laptop], "starts on the first computer");

  const { sessionId: chat } = app.trunks.startConversation({ trunkId: scout.id });
  const refused = await ask("/api/devices/pick", { sessionId: chat, deviceId: "this" });
  assert.equal(refused.status, 403, "This computer is not on Scout's list");
  assert.equal(refused.body.error, trunkComputerRefusal);
  assert.equal((await ask("/api/devices/pick", { sessionId: chat, deviceId: tower })).status, 200);
  const picked = (await ask(`/api/devices/pick/${chat}`)).body;
  assert.deepEqual([picked.picked, picked.trunkId, picked.allowed, picked.atOnce], [tower, scout.id, [laptop, tower], 2]);
  // The owner's own conversation picks any computer, and says it has no Trunk.
  assert.equal((await ask("/api/devices/pick", { sessionId, deviceId: "this" })).status, 200);
  const own = app.store.createRun(app.runtime.owner, "plain").sessionId;
  assert.equal((await ask("/api/devices/pick", { sessionId: own, deviceId: laptop })).status, 200);
  assert.deepEqual((await ask(`/api/devices/pick/${own}`)).body, { sessionId: own, picked: laptop, trunkId: null, allowed: null, atOnce: null });
});

test("at once: a second task at once is refused in words before it starts, and starts again once the first ends", async (t) => {
  const { app, scout, held, ask } = await fixture(t);
  await ask(`/api/trunks/${scout.id}/computers`, { allowed: ["this", tower], atOnce: 1 });
  const { sessionId: second } = app.trunks.startConversation({ trunkId: scout.id });
  const first = app.trunks.say(scout.id, "wait here");
  await until(() => held.length === 1);
  assert.equal(app.runtime.runsOfTrunk(scout.id).length, 1);
  await assert.rejects(app.runtime.run({ prompt: "and this", sessionId: second }),
    /Scout is already running 1 task, as many as it may run at once, so this did not start\. Wait for one to finish, or raise At once under Its computers\./);
  // The owner's own assistant is never held by a Trunk's limit.
  assert.equal((await app.runtime.run({ prompt: "hi" })).status, "completed");
  held.shift()();
  await first;
  assert.equal((await app.runtime.run({ prompt: "now this", sessionId: second })).status, "completed");
});
