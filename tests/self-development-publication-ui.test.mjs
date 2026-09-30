import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("RES711 inbox shows saved publication status and owner retry/cancel actions", async (t) => {
  const id = "a".repeat(64), seen = [];
  let entry = { id, repository: "owner/repo", branch: "branch/change", state: "blocked", reason: "GitHub is unavailable <unsafe>", nextAttemptAt: Date.now() + 15_000 };
  const { page, errors } = await newWindow(t, { seed(app) {
    app.sourcePublications.list = () => [entry];
    app.sourcePublications.retry = async (value) => { seen.push(["retry", value]); entry = { ...entry, state: "waiting", reason: "Waiting for GitHub" }; return entry; };
    app.sourcePublications.cancel = (value) => { seen.push(["cancel", value]); entry = { ...entry, state: "cancelled" }; return entry; };
  } });
  await openPlace(page, "inbox", "needs");
  await page.locator('[data-act="source-publication-retry"]').waitFor();
  assert.equal(await page.locator("unsafe").count(), 0);
  await page.locator('[data-act="source-publication-retry"]').click();
  await page.getByText("Waiting to publish", { exact: true }).waitFor();
  await page.locator('[data-act="source-publication-cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-act="source-publication-cancel"]'));
  assert.deepEqual(seen, [["retry", id], ["cancel", id]]);
  assert.deepEqual(errors, []);
});
