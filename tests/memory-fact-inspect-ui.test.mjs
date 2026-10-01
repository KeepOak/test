import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

/* TRUNK-101: one fact, chosen from its own row, shows its source and versions and can be corrected or put back.
   TRUNK-099: tidying an empty memory says there is nothing to tidy. */

test("Library tidy-up with nothing waiting says there is nothing to tidy", async (t) => {
  const { page, errors } = await newWindow(t);
  const place = await openPlace(page, "library", "memory");
  await place.locator('[data-act="tidy15"]').click();
  await page.locator(".dlg").getByText("There is nothing to tidy.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("Inspect opens the chosen fact, corrects its words and puts an earlier version back", async (t) => {
  let older, newer;
  const { app, page, errors } = await newWindow(t, { seed: async (branch) => {
    older = await branch.runtime.executeTool("memory.put", { text: "The shed key is under the blue pot", source: "Garden notes" });
    newer = await branch.runtime.executeTool("memory.put", { text: "Bins go out on Tuesday", source: "Council letter" });
  } });
  const place = await openPlace(page, "library", "memory");
  // The older fact, not the most recently changed one.
  await place.locator(`[data-act="memory-detail"][data-id="${older.id}"]`).click();
  const dialog = page.locator(".dlg");
  await dialog.getByText("Garden notes", { exact: true }).waitFor();
  await dialog.getByText("No earlier versions are kept for this fact.", { exact: true }).waitFor();
  await dialog.locator("#memory-detail-text").fill("The shed key is under the red pot");
  await dialog.locator('[data-act="memory-detail-save"]').click();
  await dialog.waitFor({ state: "detached" });
  const corrected = app.store.get("memory", "local", older.id);
  assert.equal(corrected.data.text, "The shed key is under the red pot");
  assert.equal(corrected.data.source, "Garden notes", "the source is kept");
  assert.equal(app.store.get("memory", "local", newer.id).data.text, "Bins go out on Tuesday", "the other fact is untouched");

  await place.locator(`[data-act="memory-detail"][data-id="${older.id}"]`).click();
  const earlier = dialog.locator("details").filter({ hasText: "under the blue pot" });
  await earlier.locator("summary").click();
  await earlier.locator('[data-act="memory-detail-restore"]').click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(app.store.get("memory", "local", older.id).data.text, "The shed key is under the blue pot");
  assert.deepEqual(errors, []);
});
