import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("a novice imports a CSV in Ask a spreadsheet and runs the filled SELECT", async (t) => {
  assert.equal(typeof chromium.launch, "function");
  const { page, app, errors } = await newWindow(t);
  await openPlace(page, "library", "documents");
  await page.locator('[data-act="sqlb17"]').click();
  await page.getByText("Choose a CSV, TSV, JSON or Excel file.", { exact: false }).waitFor();
  const choosing = page.waitForEvent("filechooser");
  await page.locator('[data-act="sqlimportb17"]').click();
  await (await choosing).setFiles({ name: "sample.csv", mimeType: "text/csv", buffer: Buffer.from("category,amount\nA,6\nB,10\n") });
  await page.locator('[data-act="sqlfileb17"][aria-pressed="true"]').waitFor();
  assert.equal(await page.getByLabel("SQL", { exact: true }).inputValue(), "SELECT * FROM sample");
  await page.locator('[data-act="sqlrunb17"]').click();
  await page.locator(".tbl-b17 tbody tr").last().waitFor();
  assert.deepEqual(await page.locator(".tbl-b17 tbody tr").allTextContents(), ["A6", "B10"]);
  assert.equal(app.documents.list("local").length, 1);
  assert.deepEqual(errors, []);
});
