/* wire-greyed: Settings › Advanced › Archive facts unused for was greyed. Its three choices are the engine's
   (GET/POST /api/memory/auto-archive), pressed from its value, and the row says how many facts would be set aside now.
   Mutation: in public/app/settings/pages/advanced.js drop the on("ad-archive", …) handler, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

test("Archive facts unused for is a live choice the engine keeps", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "wire-archive" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  await openSettingsPage(page, "advanced");
  await page.locator('[data-act="ad-archive"][data-v="null"][aria-pressed="true"]').waitFor({ timeout: 20000 });
  await page.locator('[data-act="ad-archive"][data-v="90"]').click();
  await page.locator('[data-act="ad-archive"][data-v="90"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/memory/auto-archive")).settings.afterDays, 90);
  assert.match(await page.locator(".ctl", { has: page.locator('[data-act="ad-archive"]') }).first().innerText(), /set aside now: 0/);
  assert.deepEqual(errors, []);
});
