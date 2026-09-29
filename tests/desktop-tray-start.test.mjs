/* PLAT-192: a quiet start in the tray makes no window until the owner opens it (its page, graphics and drawing are about
   55 MB nobody sees), and the owner is still told, exactly as the window tells them (public/app/shell/notify.js): a task
   that starts waiting for an answer plays the owner's sound (the window's own chime, played muted here) and shows the
   computer's notification (recorded here, never put on the screen). With "Show tips and pop-ups" off, nothing is told.
   Mutation: in src/desktop/main.ts make createWindow build the window whatever the start (drop the windowWaits() branch)
   and the first case fails; drop `trayNotifier = await startTrayNotifier(...)` and the second fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { desktopOptions } from "./fixtures/desktop-options.mjs";

const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 200))) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
};

async function trayStart(t) {
  const { options } = await desktopOptions({ hidden: true });
  delete options.env.BRANCH_TEST_WINDOW_AT_START; // the quiet start as the owner has it: no window until opened
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const electron = await _electron.launch(options);
  t.after(async () => {
    await electron.evaluate(async () => { await globalThis.branchEngineForTests?.end(7000); }).catch(() => undefined);
    await electron.close();
  });
  const engine = await until(() => electron.evaluate(() => {
    const host = globalThis.branchEngineForTests;
    return host?.servingAt && Array.isArray(globalThis.branchTrayNotesForTests) && globalThis.branchTrayNotifierForTests?.looks > 0
      ? { url: host.servingAt, token: host.token } : null;
  }), "the engine is up and the tray's notifications have taken their first look");
  const call = async (path, body) => {
    const response = await fetch(`${engine.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${engine.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const answer = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(answer)}`);
    return answer;
  };
  const notes = () => electron.evaluate(() => globalThis.branchTrayNotesForTests ?? []);
  const windows = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  return { electron, call, notes, windows };
}

/* A task that stops to ask: the demo model's first step writes a file, and the owner's rules ask before changes. */
async function askingTask(call) {
  await call("onboarding", { done: true });
  await call("policy", { preset: "ask-before-changes" });
  await call("run", { prompt: "Write the demo file." });
  await until(async () => (await call("state")).attention?.length > 0, "the task waits for an answer");
}

test("a quiet start makes no window, and a task that starts waiting plays the chime and shows the notification", async (t) => {
  const { call, notes, windows } = await trayStart(t);
  assert.equal(await windows(), 0, "no window is made at a quiet start");
  await askingTask(call);
  const told = await until(async () => { const n = await notes(); return n.some((x) => x.kind === "sound-played") ? n : null; }, "the owner is told");
  const note = told.find((x) => x.kind === "notification");
  assert.ok(note, `the computer's notification: ${JSON.stringify(told)}`);
  assert.ok(note.title && note.body, "it says who asks and what");
  assert.ok(note.sessionId, "a press on it opens that conversation");
  assert.deepEqual(told.filter((x) => x.kind === "sound").map((x) => x.sound), ["chime"], "the shipped sound, once");
  const played = told.find((x) => x.kind === "sound-played");
  assert.equal(played.played, true, `the window's own chime played: ${JSON.stringify(played)}`);
  assert.equal(await windows(), 0, "telling the owner makes no window (the sound's page is gone again)");
});

test("with pop-ups off, a quiet start tells nothing", async (t) => {
  const { electron, call, notes, windows } = await trayStart(t);
  await call("onboarding", { popups: false });
  await askingTask(call);
  // The look that would have told the owner is the one that marks the waiting task as seen: once it has, it kept quiet.
  const waiting = (await call("state")).attention.map((one) => one.runId);
  await until(async () => {
    const seen = await electron.evaluate(() => globalThis.branchTrayNotifierForTests?.seenRuns() ?? []);
    return waiting.every((id) => seen.includes(id));
  }, "the notifier has seen the waiting task");
  assert.deepEqual(await notes(), [], "nothing is told with pop-ups off");
  assert.equal(await windows(), 0);
});
