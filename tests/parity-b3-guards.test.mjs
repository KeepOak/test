/**
 * parity-b3 review: two guards on controls the batch made live.
 *   - Library › Documents › "Bring things in from other services": Sync now reaches the owner's other services, so a
 *     double click asks the engine once (POST /api/asks/sources/sync), never twice at the same time.
 *   - Automations › "Leads": Export as CSV writes a cell that starts like a formula as text, as the engine's own
 *     leadsCsv (src/asks/leads.ts) does, so opening the file in a spreadsheet never runs it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Sync now asks the engine once for a double click", async (t) => {
  const { page, errors } = await newWindow(t);
  let syncs = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/asks/sources/sync")) syncs++; });
  await openSettings(page);
  await setLevel(page, "advanced");
  await page.locator(".set-back").click(); // Settings holds the side column (pass 18); its Back returns to the places
  await openPlace(page, "library", "documents");
  await page.locator('#main [data-act="demob17"][data-k="sources"]').click();
  const go = page.locator(".dlg [data-act='demodob17'][data-k='sources']");
  await go.waitFor({ timeout: 20000 });
  await go.dblclick();
  await sleep(1500);
  assert.equal(syncs, 1, "one press on its way at a time");
  assert.deepEqual(errors, []);
});

test("Export as CSV writes formula-looking cells as text", async (t) => {
  const { page, errors } = await newWindow(t, { seed: (branch) => {
    branch.asks.leads.add([{ name: "=HYPERLINK(\"x\")", company: "@SUM(1)", title: "+1" }], {});
  } });
  await openSettings(page);
  await setLevel(page, "advanced");
  await page.locator(".set-back").click(); // Settings holds the side column (pass 18); its Back returns to the places
  await openPlace(page, "automations", "scheduled");
  await page.locator('#main [data-act="demob17"][data-k="leads"]').click();
  const download = page.waitForEvent("download", { timeout: 20000 });
  await page.locator(".dlg [data-act='demodob17'][data-k='leads']").click();
  const csv = await readFile(await (await download).path(), "utf8");
  const [header, row] = csv.split("\n");
  const cells = Object.fromEntries(header.split(",").map((key, i) => [key, row.split(",")[i]]));
  assert.equal(cells.name, "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(cells.company, "'@SUM(1)");
  assert.deepEqual(errors, []);
});
