import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGatewayLive, gatewayLiveRequest, gatewayApplyOwner, recoverAdoptionWindow, tellAdoptionWindow, tellGatewayWindow } from "../dist/desktop/gateway-live.js";
import { stageLive } from "../dist/hot-update/live-folder.js";
import { discardTemp } from "./temp-dir.mjs";

async function staged(t) {
  const home = await mkdtemp(join(tmpdir(), "branch-gateway-live-")); t.after(() => discardTemp(home));
  const source = join(home, "source"), appRoot = join(home, "app");
  await mkdir(join(source, "public"), { recursive: true }); await mkdir(appRoot);
  await writeFile(join(source, "public", "app.css"), "body { color: green }");
  const checked = await stageLive({ source, appRoot, commit: "a".repeat(40), version: "1.2.3", withEngine: false });
  const outcome = { tier: "window", version: "1.2.3", parts: new Set(["window"]), ...checked, changed: [{ path: "public/app.css", part: "window" }] };
  return { appRoot, outcome, request: gatewayLiveRequest(outcome) };
}

test("the broker reconstructs a live outcome from its own verified folder and refuses caller paths or unchecked versions", async (t) => {
  const f = await staged(t); let applied;
  const hooks = { apply: async (outcome) => { applied = outcome; return { tier: outcome.tier }; } };
  await applyGatewayLive(f.appRoot, hooks, f.request, () => undefined);
  assert.equal(applied.dir, f.outcome.dir); assert.equal(applied.manifest.commit, f.outcome.manifest.commit);
  await assert.rejects(applyGatewayLive(f.appRoot, hooks, { ...f.request, dir: "other-program" }, () => undefined));
  await assert.rejects(applyGatewayLive(f.appRoot, hooks, { ...f.request, version: "9.9.9" }, () => undefined), /match/);
  await assert.rejects(applyGatewayLive(f.appRoot, hooks, { ...f.request, changed: [{ path: "../outside", part: "window" }] }, () => undefined));
  await assert.rejects(applyGatewayLive(f.appRoot, hooks, { ...f.request, changed: [{ path: "src/desktop/main.ts", part: "shell" }] }, () => undefined));
});

test("changed staged bytes are refused before the retained engine or window is touched", async (t) => {
  const f = await staged(t); await writeFile(join(f.outcome.dir, "public", "app.css"), "tampered"); let called = false;
  await assert.rejects(applyGatewayLive(f.appRoot, { apply: async () => { called = true; } }, f.request, () => undefined), /not the file/);
  assert.equal(called, false);
});

test("one adoption pins its original renderer and refuses a concurrent writer until acknowledgment or rollback ends", async () => {
  const old = { name: "old" }, next = { name: "new" }; let current = old, release;
  const owner = gatewayApplyOwner({ current: () => current });
  const applying = owner.apply(() => new Promise((resolve) => { release = resolve; }));
  current = next; assert.equal(owner.control.current(), old);
  let second = false;
  await assert.rejects(owner.apply(async () => { second = true; }), /already being applied/); assert.equal(second, false);
  release("ack"); assert.equal(await applying, "ack"); assert.equal(owner.control.current(), next);
  await assert.rejects(owner.apply(async () => { throw new Error("rollback"); }), /rollback/);
  assert.equal(await owner.apply(async () => "retry"), "retry");
});

test("a refused or absent renderer cannot count as a completed update", async () => {
  const update = { commit: "a".repeat(40), styles: ["app.css"], reload: false };
  await assert.rejects(tellGatewayWindow({ current: () => null }, update), /not open/);
  await assert.rejects(tellGatewayWindow({ current: () => ({ call: async () => false }) }, update), /did not acknowledge/);
  await assert.rejects(tellGatewayWindow({ current: () => ({ call: async () => { throw new Error("storage refused"); } }) }, update), /storage refused/);
});

test("an adoption begun with no shell joined goes ahead with no window to tell; a shell that was there and refuses still fails it", async () => {
  const update = { commit: "a".repeat(40), styles: ["app.css"], reload: false };
  let current = null;
  const owner = gatewayApplyOwner({ current: () => current });
  // The gateway updating itself with no window: nothing to tell or restore, and a shell joining meanwhile is not asked.
  const told = await owner.apply(async () => {
    current = { call: async () => { throw new Error("a shell that joined later is never asked"); } };
    await tellAdoptionWindow(owner.control, update);
    await recoverAdoptionWindow(owner.control);
    return owner.control.windowless();
  });
  assert.equal(told, true);
  assert.equal(owner.control.windowless(), false, "outside an adoption there is nothing to decide");
  // A shell joined as the adoption began: it must acknowledge, as before.
  current = { call: async () => false };
  await assert.rejects(owner.apply(() => tellAdoptionWindow(owner.control, update)), /did not acknowledge/);
  await assert.rejects(owner.apply(() => recoverAdoptionWindow(owner.control)), /did not restore/);
});
