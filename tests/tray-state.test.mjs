/* PLAT-081: the tray's working and needs-you badge (src/desktop/tray-state.ts), as plain data: no Electron is started and
   no tray icon appears. The state is read from this computer's engine with the window's key; helpers are not the owner's
   questions; the badge is drawn in the bitmap's own BGRA order. */
import test from "node:test";
import assert from "node:assert/strict";
import { readTrayState, trayStateBitmap, trayStateWords } from "../dist/desktop/tray-state.js";

const engine = (runs, status = 200) => {
  const asked = [];
  const call = async (url, init) => { asked.push({ url, auth: init?.headers?.authorization }); return new Response(JSON.stringify(runs), { status }); };
  return { asked, call };
};

test("the tray reads the engine's activity with the window's key, and a helper's question is not the owner's", async () => {
  const quiet = engine([]);
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "the-key", quiet.call), "idle");
  assert.deepEqual(quiet.asked, [{ url: "http://127.0.0.1:3210/api/activity?waiting=1", auth: "Bearer the-key" }]);
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "k", engine([{ status: "running" }]).call), "working");
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "k", engine([{ status: "running", task: { state: "waiting-owner" } }]).call), "needs-you");
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "k", engine([{ status: "needs_input" }]).call), "needs-you");
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "k",
    engine([{ status: "running", parentRunId: "lead", task: { state: "waiting-owner" } }]).call), "idle", "a helper alone is not work the owner sees");
  assert.equal(await readTrayState("http://127.0.0.1:3210/", "k", engine([], 401).call), "unavailable");
  const elsewhere = engine([{ status: "running" }]);
  assert.equal(await readTrayState("http://example.com/", "k", elsewhere.call), "unavailable");
  assert.equal(elsewhere.asked.length, 0, "the key never leaves this computer");
  assert.equal(trayStateWords("needs-you"), "Needs you");
});

test("the badge is drawn in BGRA: needs-you is blue, working is green, idle leaves the icon alone", () => {
  const side = 32, blank = Buffer.alloc(side * side * 4);
  assert.equal(trayStateBitmap(blank, side, "idle", false), blank);
  const radius = Math.max(2, Math.round(side * 0.19)), centre = side - radius - 1;
  const pixel = (bitmap, x, y) => [...bitmap.subarray((y * side + x) * 4, (y * side + x) * 4 + 4)];
  // Beside the exclamation mark's stroke, inside the dot.
  const [b, g, r, a] = pixel(trayStateBitmap(blank, side, "needs-you", false), centre + 2, centre);
  assert.ok(b > r && a > 0, `needs-you is blue (B ${b} over R ${r})`);
  const [gb, gg, gr] = pixel(trayStateBitmap(blank, side, "working", false), centre, centre);
  assert.ok(gg > gb && gg > gr, "working is green");
  assert.deepEqual(pixel(trayStateBitmap(blank, side, "working", true), centre, centre).slice(0, 3), [0, 0, 0], "a template icon is black");
});
