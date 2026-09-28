/**
 * QA retest 2026-09-28, pass 2: with a CSV attached, the owner's bubble said "… overall total. [attached file:
 * branch-qa-sample.csv (document)]" above the file's own row. The engine keeps that note in the message for the model;
 * the bubble now leaves it out when the file's row is drawn, and keeps the words as typed when no file came with them.
 * Node only: the real dist/ and public/, a scripted model, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const csv = { name: "branch-qa-sample.csv", mediaType: "text/csv", data: Buffer.from("item,amount\napple,1\n").toString("base64") };

test("the owner's bubble names an attached file once, in the file's own row", async (t) => {
  const { page, app, errors } = await newWindow(t);
  const withFile = await app.runtime.run({ prompt: "Give the subtotals.", attachments: [csv], onTextDelta: () => undefined });
  assert.match(app.store.messages(withFile.sessionId)[0].content, /\[attached file: branch-qa-sample\.csv \(document\)\]$/, "the model still reads the note");
  const typed = await app.runtime.run({ prompt: "Say [attached file: nothing.txt] back to me.", onTextDelta: () => undefined });

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  const bubble = async (sessionId) => {
    await page.locator(`#side [data-act="chat"][data-id="${sessionId}"]`).click();
    await page.locator("#main .u").first().waitFor();
    return page.locator("#main .u").first().evaluate((node) => [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent).join("").trim());
  };
  assert.equal(await bubble(withFile.sessionId), "Give the subtotals.");
  assert.equal(await page.locator("#main .u-files .file", { hasText: "branch-qa-sample.csv" }).count(), 1, "the file's own row is there");
  assert.equal(await bubble(typed.sessionId), "Say [attached file: nothing.txt] back to me.", "words typed by the owner stay as typed");
  assert.deepEqual(errors, []);
});
