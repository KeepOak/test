/* The tray icon's usage ring (src/desktop/tray-ring.ts), as plain data: no Electron is started and no tray icon appears.
   The ring fills clockwise from the top with the share left, keeps the logo in its middle, is black for a macOS template
   icon, and is drawn only from this computer's engine when the owner's glance gives a share and the switch is on.
   Mutation: in trayBitmap draw every ring pixel as filled and the "a quarter left" case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { readTrayUsage, trayBitmap, trayTip, ringColour } from "../dist/desktop/tray-ring.js";
import { createBranch } from "../dist/index.js";
import { saveUsageGlanceSettings, usageGlanceSettings } from "../dist/usage-glance.js";

const SIDE = 32, LOGO = 20;
const logo = Buffer.alloc(LOGO * LOGO * 4, 0xff); // an opaque white square
const pixel = (bitmap, x, y) => [...bitmap.subarray((y * SIDE + x) * 4, (y * SIDE + x) * 4 + 4)];

test("the ring fills clockwise from the top with the share left, round the logo", () => {
  const quarter = trayBitmap(SIDE, logo, LOGO, 25, false);
  assert.equal(quarter.length, SIDE * SIDE * 4);
  assert.deepEqual(pixel(quarter, 16, 16), [255, 255, 255, 255], "the logo sits in the middle");
  const right = pixel(quarter, 30, 15), bottom = pixel(quarter, 16, 30), left = pixel(quarter, 1, 16);
  assert.ok(right[3] > 200, "a quarter left fills the top-right quarter");
  assert.ok(bottom[3] < 120 && left[3] < 120, "and leaves the rest a faint track");
  assert.deepEqual(right.slice(0, 3), ringColour(25, false), "drawn in the colour for getting low");
  const full = trayBitmap(SIDE, logo, LOGO, 100, false), empty = trayBitmap(SIDE, logo, LOGO, 0, false);
  assert.ok(pixel(full, 1, 16)[3] > 200 && pixel(full, 16, 30)[3] > 200, "all left: the whole ring");
  assert.ok(pixel(empty, 30, 15)[3] < 120, "nothing left: only the track");
  assert.deepEqual(pixel(quarter, 0, 0), [0, 0, 0, 0], "outside the ring stays clear");
});

test("a template icon is black, told apart by its alpha; colours follow what is left", () => {
  const drawn = trayBitmap(SIDE, Buffer.alloc(LOGO * LOGO * 4), LOGO, 60, true);
  for (let at = 0; at < drawn.length; at += 4) assert.deepEqual([drawn[at], drawn[at + 1], drawn[at + 2]], [0, 0, 0]);
  assert.notDeepEqual(ringColour(80, false), ringColour(30, false));
  assert.notDeepEqual(ringColour(30, false), ringColour(5, false));
  assert.throws(() => trayBitmap(SIDE, Buffer.alloc(10), LOGO, 50, false), /not the size/);
});

test("the share is read from this computer's engine only, and none is drawn without one", async () => {
  const answer = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
  const tightest = { connectionName: "Claude", accountLabel: "Work", windowTitle: "5-hour", percentLeft: 62.9 };
  const url = "http://127.0.0.1:4000/";
  assert.deepEqual(await readTrayUsage(url, "k", answer({ available: true, settings: { tray: "shown" }, tightest })),
    { percentLeft: 62, label: "Claude — Work, 5-hour" });
  assert.equal(await readTrayUsage(url, "k", answer({ available: true, settings: { tray: "hidden" }, tightest })), null, "switched off");
  assert.equal(await readTrayUsage(url, "k", answer({ available: false })), null, "not the owner at the window");
  assert.equal(await readTrayUsage(url, "k", answer({ available: true, settings: { tray: "shown" }, tightest: null })), null, "no share to say");
  let called = false;
  assert.equal(await readTrayUsage("http://example.com/", "k", async () => { called = true; return new Response("{}"); }), null);
  assert.equal(called, false, "the key never leaves for another address");
  assert.equal(trayTip(null), "Branch Agent");
  assert.equal(trayTip({ percentLeft: 62, label: "Claude — Work, 5-hour" }), "Branch Agent · 62% left · Claude — Work, 5-hour");
});

test("the tray setting ships on, and switching it keeps the ring's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-tray-ring-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(usageGlanceSettings(app.store, app.runtime.owner).tray, "shown");
  saveUsageGlanceSettings(app.store, app.runtime.owner, { ring: "hidden" });
  const next = saveUsageGlanceSettings(app.store, app.runtime.owner, { tray: "hidden" });
  assert.deepEqual([next.ring, next.tray], ["hidden", "hidden"]);
});
