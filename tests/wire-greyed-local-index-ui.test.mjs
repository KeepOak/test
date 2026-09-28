/* wire-greyed (RES-718): Settings › Advanced › "A local index of mail and calendars" was greyed ("Branch keeps no local
   index"). It is now the engine's switch (POST /api/local-index), off as shipped (the owner's rule (e)); on, it says what
   it keeps and how far back, can be brought up to date now, and, after a yes, Delete the index removes every row.
   Mutation: in public/app/settings/pages/advanced.js draw nothing in place of localIndexRow(): red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

test("the local index: a live switch that ships off, how far back, Update now, and Delete after a yes", { timeout: 180000 }, async (t) => {
  const { app, page, errors, call } = await settingsWindow(t, { name: "wire-local-index" });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const box = page.locator("#f15-a-local-index-of-mail-calendar-and-messa");
  await box.waitFor();
  assert.equal(await box.getAttribute("aria-disabled"), null, "the switch is live");
  assert.equal(await box.isChecked(), false, "it ships off: it copies the owner's mail onto this disk");

  await box.click();
  await page.locator('[data-act="li-days"][data-v="90"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/local-index")).settings.mode, "on");
  await page.locator('[data-act="li-days"][data-v="365"]').click();
  await page.locator('[data-act="li-days"][data-v="365"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/local-index")).settings.days, 365);
  await page.locator('[data-act="li-update"]').click();
  await page.locator("#li-row", { hasText: "Kept: 0 (" }).waitFor();

  // One row as a run would leave it. A run drops rows of a source that isn't set up, so it is switched off first: what is
  // kept stays until Delete.
  app.store.sqlite.prepare(`INSERT INTO local_index(owner,source,item_id,at,seen_at,who,title,body,address) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(app.runtime.owner, "gmail", "x1", new Date().toISOString(), new Date().toISOString(), "Dana", "Lease", "Signed lease", "");
  await box.click();
  await page.locator('[data-act="li-days"]').first().waitFor({ state: "detached" });
  assert.equal((await call("/api/local-index")).settings.mode, "off");
  await page.locator("#li-row", { hasText: "Kept: 1 (" }).waitFor();
  assert.equal(await page.locator('[data-act="li-update"]').count(), 0, "off, nothing is brought up to date");
  await page.locator('[data-act="li-delete"]').click();
  await page.locator('[data-act="li-delete-yes"]').click();
  await page.locator('[data-act="li-delete"]').waitFor({ state: "detached" });
  assert.equal((await call("/api/local-index")).total, 0, "every row is deleted");
  assert.deepEqual(errors, []);
});
