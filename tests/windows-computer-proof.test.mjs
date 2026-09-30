// real-screen-test
/**
 * computer-control: real proof on a throwaway Windows runner, never on the owner's PC. The file carries the marker line,
 * so scripts/review.mjs refuses it and tests/real-screen.mjs runs it only in CI on Windows (or with BRANCH_SCREEN_TESTS=1).
 *
 * Against a WinForms window far off every screen (tests/windows-proof-kit.mjs), the real Windows script:
 *   - desktop.read lists its parts with refs and boxes, and a WinForms button (which UI Automation sees only as a bare
 *     Pane) is read as a Button through its own MSAA object;
 *   - that button is pressed by name without the pointer (its MSAA default action, or the button's own message);
 *   - a pointer click on a spot off every screen is refused, with nothing done (fail closed).
 * And a held paired computer's notice is read, found on top, and its Stop pressed through the same script, as someone
 * at that computer would click it. The close-up, the live reader and the display exclusion are in
 * tests/windows-computer-capture-proof.test.mjs and tests/windows-computer-display-proof.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { realScreenAllowed } from "./real-screen.mjs";

// Only on a throwaway Windows CI runner (or BRANCH_SCREEN_TESTS=1): it makes a window, even if off every screen.
if (!realScreenAllowed()) {
  test("computer-control proof is opt-in (a Windows CI runner, or BRANCH_SCREEN_TESTS=1)", { skip: true }, () => {});
  process.exit(0);
}
const { folder, testWindow, runner, signal, list, listed, titled, pressedWithoutPointer } = await import("./windows-proof-kit.mjs");

test("the real script reads parts with refs, presses a named button without the pointer, and refuses a spot off every screen", { timeout: 300000 }, async (t) => {
  // The helper starts (its first action) while the test window starts.
  const [proof] = await Promise.all([testWindow(t, false), runner.run("windows", {}, signal())]);
  assert.ok(await listed(proof.handle), "the test window is listed");
  let started = Date.now();
  const reading = await runner.run("read", { handle: proof.handle, limit: 30 }, signal());
  t.diagnostic(`read: ${Date.now() - started} ms, of which the tree walk ${reading.readMs} ms`);
  assert.ok(reading.readMs < 8500, "the walk keeps to its time budget");
  const nodes = list(reading.nodes);
  const button = nodes.find((n) => n.name === "Proof button");
  assert.ok(button, `the button is listed: ${JSON.stringify(nodes.map((n) => n.name))}`);
  console.log(`# the button as read: ${JSON.stringify(button)}; the window: ${JSON.stringify(reading.bounds)}`);
  assert.equal(button.role, "Button", "a WinForms button is read as a Button (through its own MSAA object), not a bare Pane");
  assert.match(button.ref, /^-?[0-9]+(\.-?[0-9]+)+$/, "with UI Automation's runtime id as its ref");
  assert.equal(button.box.length, 4, "and its box in window pixels");
  assert.ok(button.box[0] >= 0 && button.box[1] >= 0 && button.box[2] > 100, `inside the window: ${button.box}`);
  assert.deepEqual([reading.bounds.x, reading.bounds.y], [-30000, -30000], "the window's own place, far off every screen");

  started = Date.now();
  const pressed = await runner.run("click", { handle: proof.handle, name: "Proof button" }, signal());
  console.log(`# pressed in ${Date.now() - started} ms: ${JSON.stringify(pressed)}`);
  assert.ok(pressedWithoutPointer.includes(pressed.how), `pressed without the pointer (the window is off every screen): ${pressed.how}`);
  assert.match(await titled(proof.handle, /^Branch proof 1 /), /^Branch proof 1 /, "the button's own handler ran once");

  // A spot on this window is off every screen: Windows would press a screen edge instead, so the pointer click is refused unsent.
  await assert.rejects(runner.run("pointer", { handle: proof.handle, kind: "click", at: { ref: button.ref }, button: "left", count: 1, modifiers: [] }, signal()),
    /nothing was done/i);
  await new Promise((done) => setTimeout(done, 400));
  assert.match(await titled(proof.handle, /^Branch proof 1 /), /^Branch proof 1 /, "no second click reached it");
  // A picture's promise: a window that is not where the picture said is refused before anything else.
  await assert.rejects(runner.run("pointer", { handle: proof.handle, kind: "move", at: { point: { x: 5, y: 5 } }, hoverMs: 0, expect: { x: 0, y: 0, w: 400, h: 300 } }, signal()),
    /moved or changed size/);
});

/*
 * Q1: a paired computer (`branch node` on Windows) held by the owner shows a notice on top of every window, naming
 * the owner, with a Stop that works there. On the runner the real notice script shows its real window; Branch's own
 * script lists it (on top), reads its words and presses its Stop by name, as someone at that computer would click it.
 */
test("a held paired computer shows a topmost notice naming the owner, and its Stop ends the hold", { timeout: 300000 }, async (t) => {
  const { NodeActions } = await import("../dist/devices/node/actions.js");
  const { noticeTitle } = await import("../dist/devices/node/commands.js");
  const notice = new NodeActions({ os: "win32", identityDir: folder }).startNotice("Proof Owner");
  t.after(() => notice.close());
  const up = await notice.shown;
  let said = null;
  void notice.stopped.then((why) => { said = why; });
  console.log(`# the notice came up: ${up}; stopped: ${said}`);
  assert.equal(up, true, "the notice window came up");
  // The window is listed once Windows shows it, which may be a moment after the notice says it is up.
  let windows = [], shown;
  for (let i = 0; i < 20 && !shown; i++) {
    windows = list((await runner.run("windows", {}, signal())).windows);
    shown = windows.find((w) => w.title === noticeTitle);
    if (!shown) await new Promise((done) => setTimeout(done, 500));
  }
  console.log(`# the windows: ${JSON.stringify(windows.map((w) => [w.title, w.className, w.topmost, w.x, w.y]))}`);
  assert.ok(shown, "the notice is listed");
  assert.equal(shown.topmost, true, "it stands on top of every window");
  const nodes = list((await runner.run("read", { handle: shown.handle, limit: 30 }, signal())).nodes);
  console.log(`# the notice as read: ${JSON.stringify(nodes.map((n) => [n.role, n.name]))}`);
  assert.ok(nodes.some((n) => n.name === "Being used from Branch by Proof Owner"), "it names the owner");
  assert.equal(nodes.find((n) => n.name === "Stop")?.role, "Button");
  const pressed = await runner.run("click", { handle: shown.handle, name: "Stop" }, signal());
  assert.ok(pressedWithoutPointer.includes(pressed.how), `Stop pressed: ${JSON.stringify(pressed)}`);
  for (let i = 0; i < 200 && !said; i++) await new Promise((done) => setTimeout(done, 50));
  assert.equal(said, "Stop was pressed on this computer.");
});
