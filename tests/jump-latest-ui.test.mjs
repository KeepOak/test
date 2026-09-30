/* UP-UI-010: scrolled up in a long conversation, a "Jump to latest" button says how many messages are below and goes
   there; text selected in the thread is not pulled away when new content arrives. A headless window on a temporary
   Branch with a seeded conversation. Mutation: always hide #jump-follow in chat/scroll-follow.js update(): red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openChat } from "./open-chat.mjs";

function seedLong(app) {
  const run = app.store.createRun(app.runtime.owner, "question 0");
  for (let i = 0; i < 30; i++) {
    app.store.message(run.sessionId, { role: "user", content: `question ${i}` });
    app.store.message(run.sessionId, { role: "assistant", content: `answer ${i}\n\n${"A long line of words to fill the thread. ".repeat(12)}` });
  }
  app.store.finish(run.id, "completed", "answer 29");
  return run.sessionId;
}

test("UP-UI-010: Jump to latest says what is below and goes there; a selection is not pulled away", { timeout: 180000 }, async (t) => {
  let sid;
  const { page, app, errors } = await newWindow(t, { seed: (branch) => { sid = seedLong(branch); } });
  await openChat(page, sid);
  await page.locator("#conversation").getByText("answer 29").waitFor();
  const button = page.locator('#jump-follow button[data-act="jump-follow"]');
  assert.equal(await page.locator("#jump-follow").isHidden(), true, "at the bottom there is nothing to jump to");
  await page.locator("#scroll").evaluate((box) => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
  await button.waitFor({ state: "visible" });
  assert.match(await button.innerText(), /^Jump to latest · \d+ messages below$/);
  await button.click();
  await page.waitForFunction(() => { const box = document.getElementById("scroll"); return box.scrollHeight - box.scrollTop - box.clientHeight < 40; });
  assert.equal(await page.locator("#jump-follow").isHidden(), true);

  // Select words well above the end, then let new work arrive in this conversation.
  await page.locator("#scroll").evaluate((box) => { box.scrollTop = box.scrollHeight / 3; });
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.getElementById("conversation"), NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node && node.textContent.trim() !== "question 10") node = walk.nextNode();
    const range = document.createRange(); range.setStart(node, node.textContent.indexOf("q")); range.setEnd(node, node.textContent.indexOf("0") + 1);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const top = await page.locator("#scroll").evaluate((box) => box.scrollTop);
  await app.runtime.run({ prompt: "one more", sessionId: sid });
  await page.waitForTimeout(1500); // the window has been told of the new messages by now
  assert.equal(await page.evaluate(() => document.getSelection().toString().trim()), "question 10", "the selection is kept");
  assert.equal(await page.locator("#scroll").evaluate((box) => box.scrollTop), top, "and the thread did not move under it");
  // Letting go of the selection brings the new messages in.
  await page.evaluate(() => document.getSelection().removeAllRanges());
  await page.locator("#conversation").getByText("one more").waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
});
