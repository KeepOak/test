// real-screen-test
/**
 * computer-control: real proof on a throwaway Windows runner, never on the owner's PC (see
 * tests/windows-computer-proof.test.mjs and tests/windows-proof-kit.mjs). A close-up of an off-screen test window
 * comes from the window itself (its own colour, not the screen's), and the live reader frames that window alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { realScreenAllowed } from "./real-screen.mjs";

// Only on a throwaway Windows CI runner (or BRANCH_SCREEN_TESTS=1): it makes a window, even if off every screen.
if (!realScreenAllowed()) {
  test("computer-control capture proof is opt-in (a Windows CI runner, or BRANCH_SCREEN_TESTS=1)", { skip: true }, () => {});
  process.exit(0);
}
const { folder, testWindow, runner, signal, listed, pixel } = await import("./windows-proof-kit.mjs");

test("the real close-up and the live reader take the window from the window itself", { timeout: 300000 }, async (t) => {
  const [proof] = await Promise.all([testWindow(t, false), runner.run("windows", {}, signal())]);
  const out = join(folder, "zoom.png");
  const zoom = await runner.run("zoom", { handle: proof.handle, region: { x: 300, y: 200, width: 40, height: 40 }, scale: 2, outPath: out }, signal());
  assert.equal(zoom.method, "window", "PrintWindow, not a copy of the screen");
  assert.ok(existsSync(out));

  const found = await listed(proof.handle);
  const target = { kind: "window", handle: proof.handle, processId: proof.processId, bounds: { x: found.x, y: found.y, w: found.width, h: found.height } };
  const reader = runner.liveProcess(target, { processId: process.pid, handles: [] });
  t.after(() => reader.close());
  // The live reader's program starts while the close-up's colour is checked.
  const [frame, colour] = await Promise.all([reader.frame(320, signal()), pixel(out, 20, 20)]);
  assert.equal(colour, "12,200,90 80x80", "the test window's own colour, enlarged twice");
  assert.equal(frame.method, "window");
  assert.deepEqual(frame.target, target);
  assert.ok(Buffer.from(frame.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG of that window");
});
