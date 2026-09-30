/* wire-greyed: two Library › Documents controls were greyed.
   - Write a new document ("the engine keeps a document only from a file or finished text"): it opens a name and text
     box and keeps the text as a document of the owner's (POST /api/documents { name, text }), listed at once.
   - Understand a folder › Start the tour ("ask for a tour in a conversation"): it now does that, starting a new
     conversation that asks for the tour (chat/chat.js startWith).
   Mutation: in public/app/places/library.js drop "doc-new" from markLive, and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "Here is the tour.", toolCalls: [] }; } };

async function documents(page) {
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const [act, data] of [["view", { v: "library" }], ["ptab", { place: "library", v: "documents" }]]) {
      const b = document.createElement("button"); b.dataset.act = act; Object.assign(b.dataset, data);
      document.getElementById("app").append(b); b.click(); b.remove();
    }
  });
  await page.waitForTimeout(1500);
}

test("Write a new document keeps the text as one of the owner's documents", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "wire-doc-new" });
  await documents(page);
  const write = page.locator('[data-act="doc-new"]');
  assert.equal(await write.getAttribute("aria-disabled"), null, "Write a new document is live");
  await write.click();
  await page.locator('[data-act="doc-new-save"]').click();
  await page.locator(".toast", { hasText: "Write something first" }).waitFor();
  await page.locator("#doc-new-name").fill("Survey plan");
  await page.locator("#doc-new-text").fill("Measure the tower again in spring.");
  await page.locator('[data-act="doc-new-save"]').click();
  await page.locator("#main .prow", { hasText: "Survey plan.md" }).waitFor({ timeout: 15000 });
  const listed = (await call("/api/documents")).documents;
  assert.deepEqual(listed.map((d) => d.name), ["Survey plan.md"]);
  assert.deepEqual(errors, []);
});

test("Start the tour starts a conversation that asks for it", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "wire-tour" });
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await documents(page);
  await page.locator('[data-act="demob17"][data-k="learnfolder"]').click();
  const start = page.locator('[data-act="demodob17"][data-k="learnfolder"]');
  await start.waitFor();
  assert.equal(await start.getAttribute("aria-disabled"), null, "Start the tour is live");
  await start.click();
  await page.locator("#main", { hasText: "guided tour of this project's folder" }).waitFor({ timeout: 20000 });
  await page.locator("#main", { hasText: "Here is the tour." }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
});
