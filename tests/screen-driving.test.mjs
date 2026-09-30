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
import { setLockdown } from "../dist/lockdown.js";
import { BackgroundScreen } from "../dist/reach/background-screen.js";

const quietBanner = { visible: false, show: async () => undefined, hide: async () => undefined };
const notepad = { title: "notes.txt - Notepad", program: "stand-in", handle: 7, minimised: false };

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

test("while the owner drives, a background press on a Mac waits too, and runs only once they hand it back", async (t) => {
  const { desktop, app, run } = await world(t);
  const execs = [];
  const exec = async (executable, args) => {
    execs.push(args[4]);
    const result = args[4] === "windows" ? { windows: [{ handle: "501:1", title: "Mail", program: "Mail" }] } : { pressed: "Send" };
    return { status: "ok", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const background = new BackgroundScreen({ store: app.store, owner: app.runtime.owner, exec, platform: "darwin",
    held: (runId, signal) => desktop.whileDriving({ runId }, signal) });
  desktop.takeOver();
  let done = false;
  const pressing = background.run({ action: "press", handle: "501:1", name: "Send" }, { runId: run.id, signal: new AbortController().signal })
    .then(() => { done = true; });
  while (!app.store.events(run.id).some((e) => e.kind === "desktop.paused")) await new Promise((r) => setImmediate(r));
  assert.equal(done, false, "it waits");
  assert.deepEqual(execs, [], "nothing reached an app while the owner drives");
  desktop.handBack();
  await pressing;
  assert.deepEqual(execs, ["windows", "press"], "handed back: the press happens");

  desktop.takeOver();
  const cancel = new AbortController();
  const stopped = background.run({ action: "press", handle: "501:1", name: "Send" }, { runId: run.id, signal: cancel.signal });
  cancel.abort();
  await assert.rejects(stopped, (error) => error.message === drivingMessage, "the task's own stop ends the wait");
  desktop.handBack();
  assert.deepEqual(execs, ["windows", "press"]);

  desktop.takeOver();
  const closing = background.run({ action: "press", handle: "501:1", name: "Send" }, { runId: run.id, signal: new AbortController().signal });
  const refused = assert.rejects(closing, (error) => error.message === drivingMessage, "closing Branch is not a hand back");
  await new Promise((resolve) => setImmediate(resolve));
  await desktop.close();
  await refused;
  assert.deepEqual(execs, ["windows", "press"], "nothing ran after Branch closed");
});

for (const revoke of ["settings", "permissions", "lockdown"]) {
  test(`a queued screen action rechecks ${revoke} after the owner hands back`, async (t) => {
    const { desktop, runner, context, app, run } = await world(t);
    let allowed = true;
    desktop.permissions = { async check() { return { allowed, message: "Screen permission was revoked." }; } };
    desktop.takeOver();
    const waiting = desktop.click({ window: "Notepad", point: { x: 1, y: 1 } }, context());
    const outcome = assert.rejects(waiting, /not allowed|revoked|Lockdown/i);
    while (!app.store.events(run.id).some((e) => e.kind === "desktop.paused")) await new Promise((r) => setImmediate(r));
    if (revoke === "settings") saveDesktopSettings(app.store, app.runtime.owner, { enabled: false });
    if (revoke === "permissions") allowed = false;
    if (revoke === "lockdown") {
      setLockdown(app.store, app.runtime.owner, { on: true });
      // Lockdown must override even a stale enabled setting when the wait ends.
      app.store.save("settings", app.runtime.owner, "desktop-control", { enabled: true });
    }
    desktop.handBack();
    await outcome;
    assert.deepEqual(runner.calls, [], "no screen action happens under the expired authorization");
  });
}

test("closing Branch cancels a queued screen action and clears driving state", async (t) => {
  const { desktop, runner, context, app, run } = await world(t);
  desktop.takeOver();
  const waiting = desktop.key({ window: "Notepad", chord: "ctrl+s" }, context());
  const outcome = assert.rejects(waiting, /waited and let go/);
  while (!app.store.events(run.id).some((e) => e.kind === "desktop.paused")) await new Promise((r) => setImmediate(r));
  await desktop.close();
  await outcome;
  assert.equal(desktop.isDriving(), false);
  assert.deepEqual(runner.calls, []);
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
  const { desktop, app } = await world(t);
  const owner = { store: app.store, owner: app.runtime.owner, profiles: { isOwner: () => true }, viaDoor: false, locked: () => null };
  assert.deepEqual(screenControl(owner, desktop, screenTakeOverPath), { driving: true });
  assert.deepEqual(screenControl(owner, desktop, screenHandBackPath), { driving: false });
  assert.throws(() => screenControl({ ...owner, viaDoor: true }, desktop, screenTakeOverPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, viaDoor: true }, desktop, screenHandBackPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, profiles: { isOwner: () => false } }, desktop, screenHandBackPath), (e) => e.status === 403);
  assert.throws(() => screenControl({ ...owner, locked: () => "Branch is locked." }, desktop, screenHandBackPath), (e) => e.status === 423);
  assert.equal(desktop.isDriving(), false, "none of those changed who drives");
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.throws(() => screenControl(owner, desktop, screenTakeOverPath), (e) => e.status === 403);
  assert.throws(() => screenControl(owner, desktop, screenHandBackPath), (e) => e.status === 403);
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
