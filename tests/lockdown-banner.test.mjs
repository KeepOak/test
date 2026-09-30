/* The red "Lockdown is on" banner follows Lockdown (GET /api/lockdown, chat/approvals.js lockdownOn), never the App
   lock. The window drew it from the engine's state `lock`, which is the App lock's own picture (src/session-lock.ts
   state(): an object, there whether or not anything is locked), so every conversation, Customize and Library showed
   "Lockdown is on" with Lockdown off.
   Mutation: put `E.state?.lock` back as lockBanner's condition in chat/dockinfo.js (or `E.state.lock` in
   places/customize.js or places/library.js), and the first half goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

const banner = (page) => page.locator("#main .lock-banner");
const readLockdown = (page) => page.evaluate(async () => (await import("/app/chat/approvals.js")).syncLockdown());

/* The conversation, Customize and Library, each opened in turn; what `look` finds on each is returned by its name. */
async function eachPlace(page, look) {
  const seen = {};
  await page.locator('#side [data-act="chat"]').first().click();
  await page.locator("#conversation").waitFor();
  seen.chat = await look();
  for (const place of ["customize", "library"]) {
    await openPlace(page, place);
    await page.locator("#main .place").first().waitFor();
    seen[place] = await look();
  }
  return seen;
}

test("with Lockdown off and an App lock set, no red Lockdown banner shows; with Lockdown on, it does", async (t) => {
  const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };
  const { page, call, errors } = await newWindow(t, { provider: quiet, seed: async (app) => { await app.runtime.run({ prompt: "hello" }); } });
  await call("/api/lock/pin", { pin: "482615" });
  await call("/api/lock/settings", { idleMinutes: 30 });
  assert.equal((await call("/api/lockdown")).on, false, "control: Lockdown is off");
  await page.evaluate(async () => (await import("/app/core/state.js")).refresh());
  assert.ok(await page.evaluate(async () => !!(await import("/app/core/state.js")).E.state?.lock?.pinSet), "control: the App lock is set");
  assert.equal(await readLockdown(page), false);

  const off = await eachPlace(page, () => banner(page).count());
  assert.deepEqual(off, { chat: 0, customize: 0, library: 0 }, "no Lockdown banner while Lockdown is off");

  await call("/api/lockdown", { on: true });
  assert.equal(await readLockdown(page), true);
  const on = await eachPlace(page, async () => { await banner(page).first().waitFor({ state: "visible", timeout: 15000 }); return banner(page).count(); });
  assert.deepEqual(on, { chat: 1, customize: 1, library: 1 }, "the banner shows everywhere while Lockdown is on");
  assert.deepEqual(errors, []);
});
