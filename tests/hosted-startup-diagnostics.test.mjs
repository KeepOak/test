import test from "node:test";
import assert from "node:assert/strict";
import { STARTUP_MS, connected, desktopConnectionState, desktopStartupFailure, firstDesktopWindow, launchDesktop } from "./fixtures/desktop-options.mjs";

test("desktop startup uses the shared launch budget for its first window", async () => {
  let requested;
  const page = {};
  const electron = { firstWindow: async (options) => { requested = options; return page; } };
  assert.equal(await firstDesktopWindow(electron), page);
  assert.deepEqual(requested, { timeout: STARTUP_MS });
  assert.equal(await launchDesktop({ launch: async (options) => options }, { timeout: STARTUP_MS }).then((value) => value.timeout), STARTUP_MS);
});

test("desktop startup failures name the phase and bounded elapsed time without raw error contents", async () => {
  const privateError = new Error("private path and page text");
  privateError.name = "TimeoutError";
  const message = desktopStartupFailure("firstWindow", 1000, privateError, 125000).message;
  assert.match(message, /firstWindow timed out after 124000 ms \(limit 120000 ms\)/);
  assert.doesNotMatch(message, /private|path|page/);
  await assert.rejects(firstDesktopWindow({ firstWindow: async () => { throw privateError; } }), /firstWindow timed out/);
  await assert.rejects(launchDesktop({ launch: async () => { throw privateError; } }, {}), /launch timed out/);
  assert.match(desktopStartupFailure("launch", 0, privateError, 999999).message, /after 360000 ms/);
});

test("connection snapshot contains only bounded state and never page or response text", async () => {
  const state = await desktopConnectionState({ isClosed: () => false, evaluate: async () => ({
    ready: "complete", app: true, status: true, machine: true, connected: false, version: false, offline: true, apiStatus: 503,
  }) });
  assert.deepEqual(state, { ready: "complete", app: true, status: true, machine: true, connected: false, version: false, offline: true, apiStatus: 503 });
  assert.deepEqual(await desktopConnectionState({ isClosed: () => true }), { page: "unavailable" });
  const page = { isClosed: () => false, evaluate: async () => state,
    locator: () => ({ locator: () => ({ filter: () => ({ waitFor: async () => { throw new Error("private response text"); } }) }) }) };
  await assert.rejects(connected(page), (error) => error.message.includes("desktop connected phase failed")
    && error.message.includes('"apiStatus":503') && !error.message.includes("private"));
});
