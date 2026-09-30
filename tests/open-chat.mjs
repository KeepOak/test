/**
 * trunk-one-row: the side list has one row per Trunk, which opens the Trunk's newest conversation (and names the one open
 * in it). A test that needs one exact conversation opens it by its id, as search and the Inbox do (chat/chat.js
 * openConversation); its row is clicked when the list has one for it.
 */
export async function openChat(page, sessionId) {
  await page.locator("#side .row").first().waitFor({ timeout: 20000 });
  const row = page.locator(`#side [data-act="chat"][data-id="${sessionId}"]`).first();
  if (await row.count() && await row.getAttribute("aria-current") === "true") return; // already open
  if (await row.count() && !(await row.getAttribute("data-line"))) await row.click();
  else await page.evaluate((id) => import("/app/chat/chat.js").then((chat) => chat.openConversation(id)), sessionId);
  await page.waitForFunction((id) => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id === id, sessionId, { timeout: 20000 });
}

