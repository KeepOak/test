import test from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { backToConversation, connected, desktopOptions, onboarded, openSettingsPage, send, taskDone, tokenNotExposed } from "./fixtures/desktop-options.mjs";

/* Redesign: the old window's identity form (Assistant name, Working instructions, Save identity) is gone. The prototype
   names the assistant in Settings › Instructions & personality instead: IDENTITY.md, "Its name and how it introduces
   itself", edited in place, with a "Read IDENTITY.md" switch on its row that decides whether a task reads it. What a
   task carried is the engine's context.files event (src/context-files.ts), so that is what "applies to a new task"
   checks now, in place of the old form's identity.applied record. */
const IDENTITY = "# Native Juniper\n\nKeep checked results concise.\n";

async function openIdentityFile(page) {
  await openSettingsPage(page, "instructions");
  await page.locator('[data-act="if-open"][data-f="identity"]').click();
  return page.locator("#if-text");
}

test("native identity settings survive restart and apply to a new task without exposing the local token", { timeout: 360000 }, async () => {
  const { home, options } = await desktopOptions();
  const first = await _electron.launch(options);
  try {
    const page = await first.firstWindow();
    await onboarded(page);
    await (await openIdentityFile(page)).fill(IDENTITY);
    await page.locator('[data-act="if-save"][data-f="identity"]').click();
    await page.locator(".toast").filter({ hasText: /^Saved\./ }).waitFor();
    await tokenNotExposed(page, home);
  } finally { await first.close(); }
  const second = await _electron.launch(options);
  try {
    const page = await second.firstWindow();
    await connected(page);
    assert.equal(await (await openIdentityFile(page)).inputValue(), IDENTITY);
    await page.locator('.dlg [data-act="dlg-close"]').first().click();
    // The prototype's switch on the file's row; the new window draws the row without it (a listed window bug), and a
    // saved file stays off, so no task would read it.
    const read = page.getByLabel("Read IDENTITY.md", { exact: true });
    await read.waitFor({ timeout: 10000 }).catch(() => {
      throw new Error("Window bug: Instructions & personality has no \"Read IDENTITY.md\" switch (the prototype's row has one), so a saved IDENTITY.md is never read by a task");
    });
    await read.check();
    await backToConversation(page);
    await send(page, "Run the file workflow.");
    const result = await taskDone(page, "Run the file workflow.");
    assert.equal(result.run.status, "completed");
    assert.deepEqual(result.events.find((event) => event.kind === "context.files")?.data.carried, ["IDENTITY.md"]);
    await tokenNotExposed(page, home);
  } finally { await second.close(); }
});
