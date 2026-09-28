/* A window hidden a while is dropped (15 minutes; here 1.5 s) and made again when it is opened, with what it had open:
   the conversation and its unsent draft come back (public/app/shell/keep.js, src/desktop/main.ts dropWindow). While
   something lives only in the page (here an unsaved field), it is kept. Any window this test opens is placed off the
   screen before it is shown, and never in the taskbar.
   Mutation: make keptNow() return {} and the draft does not come back; make heldBy() return "" and the kept window is
   dropped. */
import test from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { desktopOptions, onboarded } from "./fixtures/desktop-options.mjs";

const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 100))) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
};

async function launch(t) {
  const { options } = await desktopOptions({ hidden: true });
  Object.assign(options.env, { BRANCH_TEST_ENGINE_HOOKS: "1", BRANCH_TEST_DROP_HIDDEN_MS: "1500" });
  const electron = await _electron.launch(options);
  t.after(async () => {
    await electron.evaluate(async () => { await globalThis.branchEngineForTests?.end(7000); }).catch(() => undefined);
    await electron.close();
  });
  const page = await electron.firstWindow();
  await onboarded(page);
  const windows = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  // The owner closes the window to the tray: it is hidden (it never was on this screen, so "hide" is said for it).
  const hide = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit("hide"));
  return { electron, page, windows, hide };
}

test("a window hidden a while is dropped, and opened again with its conversation and its unsent draft", async (t) => {
  const { electron, page, windows, hide } = await launch(t);
  const sessionId = await page.evaluate(async () => {
    const answer = await (await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Kept here" }) })).json();
    return answer.sessionId ?? answer.run?.sessionId;
  });
  assert.ok(sessionId, "a conversation to have open");
  await page.evaluate(async (id) => { const { openConversation } = await import("/app/chat/chat.js"); await openConversation(id); }, sessionId);
  await page.locator("#prompt").fill("words not sent yet");
  await hide();
  await until(async () => (await windows()) === 0, "the hidden window is dropped");
  assert.equal(await electron.evaluate(() => Boolean(globalThis.branchTrayNotifierForTests)), true, "the owner is told from main meanwhile");

  // Opened again (from the tray, or a second start): off the screen and out of the taskbar in this test.
  await electron.evaluate(({ app }) => {
    app.once("browser-window-created", (_event, win) => { win.setSkipTaskbar(true); win.setPosition(-30000, -30000); win.once("show", () => win.setPosition(-30000, -30000)); });
    globalThis.reopenAtForTests = Date.now();
    app.emit("second-instance");
  });
  const again = await electron.waitForEvent("window");
  await until(() => again.evaluate(() => document.querySelector("#prompt")?.value === "words not sent yet").catch(() => false), "the draft is back");
  const open = await again.evaluate(async () => (await import("/app/core/state.js")).S.chat);
  assert.equal(open, sessionId, "the conversation it had open is open again");
  const took = await electron.evaluate(() => Date.now() - globalThis.reopenAtForTests);
  t.diagnostic(`reopened with its draft ${took} ms after the press`);
  assert.equal(await windows(), 1);
});

test("a window holding an unsaved change is kept, and says why", async (t) => {
  const { electron, page, windows, hide } = await launch(t);
  await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<input id="half-done" value="">'); document.querySelector("#half-done").value = "typed, not saved"; });
  await hide();
  const why = await until(() => electron.evaluate(() => globalThis.branchDropHeldForTests), "the page is asked");
  assert.match(why, /not saved/);
  assert.equal(await windows(), 1, "the window is kept");
});
