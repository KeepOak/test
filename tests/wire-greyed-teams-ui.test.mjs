/* wire-greyed (RES-721): Customize › Specialists › how Trunks work together › "Teams" was greyed ("Branch has no teams
   of small groups with their own leads"). It is now a way the engine knows (src/team-pattern.ts "teams",
   src/team-groups.ts delegate.teams over the owner's saved teams): choosing it saves it, and choosing it again gives the
   choice back to Branch.
   Mutation: in public/app/places/customize.js give the Teams card its old data-act "pat15-teams" back: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";

test("Teams is a way Trunks can work together: chosen, it is the engine's pattern; chosen again, Branch picks", { timeout: 180000 }, async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "wire-teams" });
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-place="customize"][data-v="specialists"]').click();
  const card = page.locator('.pat15[data-v="teams"]');
  await card.waitFor();
  assert.equal(await card.getAttribute("aria-disabled"), null, "the Teams card is live");
  await card.click();
  await page.locator('.pat15[data-v="teams"][aria-checked="true"]').waitFor();
  assert.equal((await call("/api/orchestration")).pattern, "teams", "the engine keeps Teams");
  await card.click();
  await page.locator('.pat15[data-v="teams"][aria-checked="false"]').waitFor();
  assert.equal((await call("/api/orchestration")).pattern, "auto", "chosen again, it is Branch's to pick");
  assert.deepEqual(errors, []);
});
