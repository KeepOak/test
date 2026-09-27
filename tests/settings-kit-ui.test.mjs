import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openSettings } from "./places.mjs";

/* R17-S02, S03, S05, S06, S07 in the window, at phone width: presets and putting settings back with
   the change list, one settings file, which file does what, and what first run offers next. */

const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* The new window, at phone width: Settings › Instructions & personality lists which file does what, and one is written
   without leaving the window (the prototype's editor), into the file the engine keeps. */
test("R17-S05: which file does what, and writing one without leaving the window, at 400 px", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const { app, page, errors } = await settingsWindow(t, { name: "kit-ui", width: 400, height: 800 });
  await openSettingsPage(page, "instructions");
  const rows = page.locator(".set-col .prow");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 8);
  const soul = rows.filter({ hasText: "SOUL.md" });
  assert.match(await soul.textContent(), /Who your assistant is: tone and boundaries/);
  assert.match(await soul.textContent(), /Empty/);
  await soul.getByRole("button", { name: "Write", exact: true }).click();
  await page.getByRole("textbox", { name: "SOUL.md", exact: true }).fill("Speak plainly and briefly.");
  await page.locator(".dlg").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  assert.equal((await readFile(join(app.store.folder, "SOUL.md"), "utf8")).trim(), "Speak plainly and briefly.");
  await rows.filter({ hasText: "SOUL.md" }).filter({ hasText: /1 line(?!s)/ }).waitFor();
  assert.ok(await noSidewaysScroll(page));
  assert.deepEqual(errors, []);
});

