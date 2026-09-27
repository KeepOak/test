/**
 * The Trunk's cursor and "You're driving" on this computer's live screen (src/integrations/desktop.ts, src/live-screen.ts).
 * Every screen here is a stand-in: an injected runner answers as the Windows script does, so nothing reaches this
 * computer's real screen, keyboard or windows (src/integrations/real-screen-guard.ts would refuse it anyway).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { DesktopControl, drivingMessage } from "../dist/integrations/desktop.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";
import { placeOnFrame, screenControl, screenTakeOverPath, screenHandBackPath } from "../dist/live-screen.js";
import { desktopScript, screenBox } from "../dist/integrations/desktop-script.js";

const quietBanner = { visible: false, show: async () => undefined, hide: async () => undefined };
const notepad = { title: "notes.txt - Notepad", program: "notepad.exe", handle: 7, minimised: false };

/** A screen that is not there: every action is written down and answered as the Windows script answers it. */
function standIn() {
  const calls = [];
  const runner = {
    calls,
    liveProcess: () => null,
    async temporaryPng(name) { return join(tmpdir(), `${name}.png`); },
    async run(action, payload) {
      calls.push([action, payload]);
      if (action === "windows") return { windows: [notepad] };
      if (action === "click") return payload.name ? { how: "invoke", name: payload.name, at: [640, 400] } : { how: "point", name: "", at: [100 + payload.x, 50 + payload.y] };
      return {};
    },
    async close() {},
  };
  return runner;
}
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-driving-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const runner = standIn();
  const desktop = new DesktopControl(app.store, { runner, banner: quietBanner });
  const run = app.store.createRun(app.runtime.owner, "use the screen");
  const context = (signal = new AbortController().signal) => ({ ...app.runtime.context({ runId: run.id }), signal, trunk: "trunk-ada" });
  return { app, root, runner, desktop, run, context };
}

test("a click says where it landed; the cursor is placed on the frame while its task goes, and gone after", async (t) => {
  const { desktop, run, context } = await world(t);
  assert.equal(desktop.pointer(), null);
  await desktop.click({ window: "Notepad", point: { x: 20, y: 30 } }, context());
  const at = desktop.pointer();
  assert.deepEqual([at.x, at.y, at.runId, at.trunk], [120, 80, run.id, "trunk-ada"], "the window's corner plus the point, on the screen");
  const screen = { x: 0, y: 0, w: 1280, h: 800 };
  assert.deepEqual(placeOnFrame(at, screen), { x: 0.0938, y: 0.1, at: at.at, trunk: "trunk-ada" });
  assert.equal(placeOnFrame(at, { x: 1280, y: 0, w: 1920, h: 1080 }), null, "a click on another screen is not drawn on this one");
  assert.equal(placeOnFrame(at, undefined), null);
  await desktop.click({ window: "Notepad", name: "Save" }, context());
  assert.deepEqual([desktop.pointer().x, desktop.pointer().y], [640, 400], "a named control: the middle of it");
  await desktop.closeRun({ runId: run.id });
  assert.equal(desktop.pointer(), null, "the task ended: no cursor");
  // The Windows script reports it for every kind of click, and the live frame names its screen in the same pixels.
  const click = /'click' \{([\s\S]*?)\n  'type'/.exec(desktopScript)?.[1] ?? "";
  assert.equal((click.match(/at = \$at/g) ?? []).length, 5, "every way of pressing a named control says where it is");
  assert.match(click, /at = @\(\$x, \$y\)/);
  assert.match(desktopScript, /\\"screen\\":\{\\"x\\":"\)\.Append\(bounds\.X\)/);
  assert.deepEqual(screenBox({ x: -1920, y: 0, w: 1920, h: 1080 }), { x: -1920, y: 0, w: 1920, h: 1080 });
  assert.equal(screenBox({ x: 0, y: 0, w: 0, h: 10 }), undefined);
});

test("while the owner drives, every screen action waits, and carries on only once they hand it back", async (t) => {
  const { desktop, runner, context, app, run } = await world(t);
  assert.deepEqual(desktop.takeOver().driving, true);
  assert.equal(desktop.isDriving(), true);
  let done = false;
  const clicking = desktop.click({ window: "Notepad", point: { x: 1, y: 1 } }, context()).then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "it waits");
  assert.deepEqual(runner.calls.map(([action]) => action), [], "nothing reached the screen while the owner drives");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "desktop.paused"), "the task's record says it waited");
  desktop.handBack();
  await clicking;
  assert.equal(done, true);
  assert.deepEqual(runner.calls.map(([action]) => action), ["windows", "click"], "handed back: the click happens");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "desktop.resumed"));
});

test("the task's Stop or its own end lets go of a wait; taking over twice is one take-over", async (t) => {
  const { desktop, runner, context, run } = await world(t);
  desktop.takeOver();
  const since = desktop.takeOver().since;
  assert.equal(desktop.takeOver().since, since, "taking over again changes nothing");
  const cancel = new AbortController();
  const waiting = desktop.key({ window: "Notepad", chord: "ctrl+s" }, context(cancel.signal));
  cancel.abort();
  await assert.rejects(waiting, (error) => error.message === drivingMessage);
  const second = desktop.type({ window: "Notepad", text: "hello" }, context());
  await new Promise((resolve) => setImmediate(resolve)); // it is waiting now
  desktop.stop(run.id);
  await assert.rejects(second, (error) => error.message === drivingMessage, "the Stop button ends the wait too");
  desktop.handBack();
  assert.deepEqual(runner.calls, [], "nothing ever reached the screen");
  assert.equal(desktop.isDriving(), false);
});

test("only the owner at this computer's own window takes over or hands back; a key, a door or a lock is refused", async (t) => {
  const { desktop } = await world(t);
  const owner = { profiles: { isOwner: () => true }, viaDoor: false, locked: () => null };
  assert.deepEqual(screenControl(owner, desktop, screenTakeOverPath), { driving: true });
  assert.deepEqual(screenControl(owner, desktop, screenHandBackPath), { driving: false });
  assert.throws(() => screenControl({ ...owner, viaDoor: true }, desktop, screenTakeOverPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, viaDoor: true }, desktop, screenHandBackPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, profiles: { isOwner: () => false } }, desktop, screenHandBackPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, locked: () => "Branch is locked." }, desktop, screenHandBackPath), (e) => e.status === 423);
  assert.equal(desktop.isDriving(), false, "none of those changed who drives");
  for (const path of [screenTakeOverPath, screenHandBackPath])
    assert.match(offLimitsToShortLivedKeys("POST", path) ?? "", /short-lived key/, `${path} is refused to every short-lived key`);
});

test("the routes: the owner's window takes over and hands back this computer's screen; a body is refused", async (t) => {
  const { app, root } = await world(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body = {}) => {
    const response = await fetch(server.url + path, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await post(screenTakeOverPath), { status: 200, body: { driving: true } });
  assert.equal(app.desktop.isDriving(), true);
  assert.equal((await post(screenHandBackPath, { to: "trunk" })).status, 400);
  assert.equal(app.desktop.isDriving(), true, "a malformed hand-back hands nothing back");
  assert.deepEqual(await post(screenHandBackPath), { status: 200, body: { driving: false } });
  const unauthenticated = await fetch(server.url + screenTakeOverPath, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(app.desktop.isDriving(), false);
});
