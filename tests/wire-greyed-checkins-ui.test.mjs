/* wire-greyed: Automations › Check-ins › Which hours › Work hours was greyed ("the engine keeps no work hours"). It is the
   span 9 AM to 5 PM now, saved as the check-in's own hours (POST /api/heartbeat activeHours 09:00–17:00), and pressed
   whenever that is the span kept; Always takes the span away again.
   Mutation: in public/app/places/automations.js make hb-hours ignore "work", and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

test("Work hours saves 9 to 5 as the check-in's hours, and Always clears it", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "wire-checkins" });
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const [act, data] of [["view", { v: "automations" }], ["ptab", { place: "automations", v: "checkins" }]]) {
      const b = document.createElement("button"); b.dataset.act = act; Object.assign(b.dataset, data);
      document.getElementById("app").append(b); b.click(); b.remove();
    }
  });
  const work = page.locator('[data-act="hb-hours"][data-v="work"]');
  await work.waitFor({ timeout: 20000 });
  assert.equal(await work.getAttribute("aria-disabled"), null, "Work hours is live");
  await work.click();
  await page.locator('[data-act="hb-hours"][data-v="work"][aria-pressed="true"]').waitFor();
  assert.deepEqual((await call("/api/heartbeat")).heartbeat.settings.activeHours, { from: "09:00", to: "17:00" });
  await page.locator('[data-act="hb-hours"][data-v="always"]').click();
  await page.locator('[data-act="hb-hours"][data-v="always"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/heartbeat")).heartbeat.settings.activeHours, null);
  assert.deepEqual(errors, []);
});
