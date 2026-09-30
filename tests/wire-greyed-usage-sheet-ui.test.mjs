/* Defaults audit: usage is always counted in Branch's own data, and a spreadsheet is written only when asked. In the
   desktop app, where downloads stay blocked, Usage › Open the report › Save as a spreadsheet asks the engine to write
   the report's days into the workspace's usage folder (POST /api/usage/metering/now { range }) and says where; before,
   the button did nothing there. The desktop bridge is stood in; headless.
   Mutation: in public/app/settings/pages/usage.js drop the branchDesktop branch of saveCsv, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

test("in the desktop app, Save as a spreadsheet writes the report into the workspace and says where", async (t) => {
  const route = (page) => page.addInitScript(() => { window.branchDesktop = {}; });
  const { page, errors, call } = await settingsWindow(t, { provider, route, name: "wire-usage-sheet" });
  await call("/api/run", { prompt: "count me" });
  await openSettingsPage(page, "usage");
  await page.locator('[data-act="repopen15"]').click();
  const save = page.locator('.dlg [data-act="repcsv15"]');
  await save.waitFor();
  await save.click();
  const toast = page.locator(".toast", { hasText: "Saved in your workspace" });
  await toast.waitFor({ timeout: 15000 });
  const path = (await toast.innerText()).replace(/^.*Saved in your workspace:\s*/s, "").trim();
  assert.match(path.replaceAll("\\", "/"), /usage\/usage-report-30d-/);
  assert.ok(existsSync(path), path);
  assert.deepEqual(errors, []);
});
