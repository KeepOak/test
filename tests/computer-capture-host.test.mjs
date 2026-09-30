/**
 * computer-control: the desktop app's main process hides its own windows from capture while a computer view is open
 * (src/desktop/capture-service.ts, over src/desktop/capture-link.ts), so the view never shows itself. Electron's
 * windows here are stand-ins that remember their content protection; no window is created and nothing is captured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureService } from "../dist/desktop/capture-service.js";
import { trustedCaptureLease } from "../dist/desktop/capture-link.js";

const first = "a".repeat(32), second = "b".repeat(32);
function stand(handle = 101n) {
  const window = { protectedNow: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isContentProtected() { return this.protectedNow; },
    setContentProtection(value) { this.protectedNow = value; },
    getNativeWindowHandle: () => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(handle); return bytes; } };
  return window;
}

test("a view's lease hides every Branch window, a window opened meanwhile too, and the last lease going shows them again", () => {
  const listeners = [], main = stand(101n), banner = stand(202n), windows = [main];
  const service = captureService({ platform: "win32", release: "10.0.26200", processId: 77, windows: () => windows,
    onCreated: (listener) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); } });
  assert.deepEqual(service.acquire({ leaseId: first }), { processId: 77, handles: ["101"] });
  assert.equal(main.protectedNow, true);
  windows.push(banner); listeners[0](banner);
  assert.equal(banner.protectedNow, true, "the Stop notice opened during the view is hidden as it appears");
  assert.deepEqual(service.acquire({ leaseId: second }), { processId: 77, handles: ["101", "202"] });
  assert.equal(service.release({ leaseId: first }), true);
  assert.equal(main.protectedNow, true, "another view still holds it");
  assert.equal(service.release({ leaseId: second }), true);
  assert.deepEqual([main.protectedNow, banner.protectedNow, listeners.length], [false, false, 0]);
  service.acquire({ leaseId: first }); service.close();
  assert.equal(main.protectedNow, false, "an engine that stopped leaves nothing hidden");
  assert.throws(() => service.acquire({ leaseId: "not-a-lease" }));
});

test("an older Windows or another system refuses rather than showing Branch in its own view", () => {
  for (const host of [{ platform: "win32", release: "10.0.18363" }, { platform: "darwin", release: "24.0.0" }, { platform: "linux", release: "6.8.0" }]) {
    const window = stand();
    const service = captureService({ ...host, processId: 77, windows: () => [window], onCreated: () => () => undefined });
    assert.throws(() => service.acquire({ leaseId: first }), /Windows 10 version 2004/);
    assert.equal(window.protectedNow, false);
  }
  const stubborn = stand(); stubborn.setContentProtection = () => undefined;
  const service = captureService({ platform: "win32", release: "10.0.19045", processId: 77, windows: () => [stubborn], onCreated: () => () => undefined });
  assert.throws(() => service.acquire({ leaseId: first }), /could not exclude/, "a window that will not be hidden refuses the view");
});

test("the engine asks only its own main process, with strict leases and a strict answer", async () => {
  const proof = { processId: 77, handles: ["101"] }, calls = [];
  const client = trustedCaptureLease({ call: async (method, args) => { calls.push([method, args]); return method === "capture-acquire" ? proof : true; } }, true);
  assert.deepEqual(await client.acquire(first), proof); await client.release(first);
  assert.deepEqual(calls, [["capture-acquire", { leaseId: first }], ["capture-release", { leaseId: first }]]);
  await assert.rejects(client.acquire("bad"));
  await assert.rejects(trustedCaptureLease({ call: async () => ({ ...proof, extra: 1 }) }, true).acquire(first));
});

test("the desktop app wires it: main's broker answers capture-acquire and capture-release, lets go when the engine stops, and the engine uses it", () => {
  // #585's wiring, now in the base: main's services make the capture host, its broker answers the engine.
  const services = readFileSync(new URL("../src/desktop/engine-services.ts", import.meta.url), "utf8");
  assert.match(services, /capture: captureService\(\{/);
  assert.match(services, /windows: \(\) => BrowserWindow\.getAllWindows\(\)/, "main decides which windows; the engine names none");
  const broker = readFileSync(new URL("../src/desktop/engine-broker.ts", import.meta.url), "utf8");
  assert.match(broker, /"capture-acquire": \(args\) => \{/);
  assert.match(broker, /"capture-release": \(args\) => \{/);
  const main = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /onGone: \(code\) => \{ closeCapture\(\);/, "a stopped engine's leases die with it");
  const engine = readFileSync(new URL("../src/desktop/engine-process.ts", import.meta.url), "utf8");
  assert.match(engine, /nativeCaptureLease: trustedCaptureLease\(link, !config\.gateway\)/);
});
