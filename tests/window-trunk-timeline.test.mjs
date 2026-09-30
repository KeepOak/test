/* trunk-one-row: one sidebar row per Trunk, and one timeline per Trunk that stitches its conversations together. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./trunks-helpers.mjs";
import { startServer } from "../dist/server.js";
import { saveOnboarding } from "../dist/onboarding.js";

/* A long answer for words that ask for one, so a conversation fills the window and older ones wait to be scrolled to. */
const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n\n");
const long = ({ last }) => (/long/.test(last?.content ?? "") ? LONG : null);

async function open(t, app, root, size = { width: 1280, height: 800 }) {
  const server = await startServer(app, { dataDir: root, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ serviceWorkers: "block", viewport: size });
  const errors = [], reads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() === "GET") reads.push(new URL(request.url()).pathname); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible" });
  return { page, errors, reads };
}
const at = (ms) => new Date(Date.now() - ms).toISOString();
const age = (app, sessionId, ms) => app.store.sqlite.prepare("UPDATE messages SET created_at=? WHERE session_id=?").run(at(ms), sessionId);
const runBody = (page) => page.waitForRequest((r) => r.url().endsWith("/api/run") && r.method() === "POST").then((r) => r.postDataJSON());

test("each Trunk is one row, and its conversations are one timeline, oldest first, with a line where each begins", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault(), kite = app.trunks.create({ name: "Kite" });
  await app.trunks.introduced();
  const first = await app.runtime.run({ prompt: "first talk", trunkId: home.id });
  const second = await app.runtime.run({ prompt: "second talk", trunkId: home.id });
  const third = await app.runtime.run({ prompt: "third talk", trunkId: home.id });
  const kiteThread = await app.runtime.run({ prompt: "kite thread", trunkId: kite.id }); // like a chat app's thread with Kite
  const noon = new Date();
  noon.setDate(noon.getDate() - 1);
  noon.setHours(12, 0, 0, 0);
  age(app, first.sessionId, Date.now() - noon.getTime()); // yesterday at noon: its line names the day
  age(app, second.sessionId, 2 * 3600000);
  age(app, home.chatSessionId, 3 * 3600000);
  const { page, errors } = await open(t, app, root);

  const homeRow = page.locator(`#side .row[data-line="${home.id}"]`);
  await homeRow.waitFor();
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).count(), 1, "the default Trunk is one row");
  assert.equal(await page.locator(`#side .row[data-line="${kite.id}"]`).count(), 1, "Kite, with its own chat and a thread, is one row");
  assert.equal(await page.locator(`#side .row[data-line]`).count(), app.trunks.records.list().length, "one row per Trunk");
  for (const run of [first, second, { sessionId: kite.chatSessionId }]) assert.equal(await page.locator(`#side .row[data-id="${run.sessionId}"]`).count(), 0, "no row of its own for a conversation");
  assert.equal(await homeRow.getAttribute("data-id"), third.sessionId, "the row opens the conversation written in last");
  assert.equal(await page.locator(`#side .row[data-line="${kite.id}"]`).getAttribute("data-id"), kiteThread.sessionId);
  assert.match(await homeRow.textContent(), /Done\./, "the row shows the newest message");

  await homeRow.click();
  const thread = page.locator("#scroll");
  await thread.locator(".u", { hasText: "first talk" }).waitFor();
  const text = await thread.textContent();
  assert.ok(text.indexOf("first talk") < text.indexOf("second talk") && text.indexOf("second talk") < text.indexOf("third talk"), "oldest at the top, newest at the bottom");
  const lines = await page.locator("#scroll .tl-sep19").allTextContents();
  assert.equal(lines.length, 4, "a line where each of the four conversations begins");
  assert.ok(lines.every((line) => line.startsWith("New conversation")), lines.join(" | "));
  assert.match(lines[0], /Yesterday/, "a day stamp on the conversation begun yesterday");
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).getAttribute("aria-current"), "true");

  // What is typed goes to the conversation written in last, the one at the bottom.
  const sent = runBody(page);
  await page.locator("#prompt").fill("fourth words");
  await page.keyboard.press("Enter");
  assert.equal((await sent).sessionId, third.sessionId);
  await thread.locator(".u", { hasText: "fourth words" }).waitFor();
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).count(), 1);

  // An older conversation opened on purpose (search, the Inbox) is where the box sends until the row is pressed again,
  // which goes back to the newest.
  await page.evaluate((id) => import("/app/chat/chat.js").then((chat) => chat.openConversation(id)), first.sessionId);
  await page.waitForFunction((id) => document.querySelector('#side .row[aria-current="true"]')?.dataset.id === id, first.sessionId);
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  await page.waitForFunction((id) => document.querySelector('#side .row[aria-current="true"]')?.dataset.id === id, third.sessionId);
  // A slow engine may still be answering "fourth words": until it has, the next words join its waiting line instead.
  await page.locator("#send:not(.stop)").waitFor();
  const again = runBody(page);
  await page.locator("#prompt").fill("fifth words");
  await page.keyboard.press("Enter");
  assert.equal((await again).sessionId, third.sessionId);
  assert.deepEqual(errors, []);
});

/* A slow engine (CI under load) answered the fourth message after the first conversation had been opened, and the window
   drew the answered one over it (#900, #901). Here the answer is held until the other conversation is open. */
test("an answer that comes back after another conversation was opened leaves that one on screen", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  const older = await app.runtime.run({ prompt: "older talk", trunkId: home.id });
  age(app, older.sessionId, 3600000);
  const newer = await app.runtime.run({ prompt: "newer talk", trunkId: home.id });
  const { page, errors } = await open(t, app, root);
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  await page.locator("#scroll .u", { hasText: "newer talk" }).waitFor();

  let release;
  const held = new Promise((done) => { release = done; });
  await page.route("**/api/run", async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  const sent = runBody(page);
  await page.locator("#prompt").fill("slow words");
  await page.keyboard.press("Enter");
  assert.equal((await sent).sessionId, newer.sessionId);
  await page.evaluate((id) => import("/app/chat/chat.js").then((chat) => chat.openConversation(id)), older.sessionId);
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/run"));
  release();
  await answered;
  // The send's last reads (its conversation's cost) come after anything it would have drawn.
  await page.waitForRequest((r) => /^\/api\/sessions\/[^/]+\/cost$/.test(new URL(r.url()).pathname));
  const shown = await page.evaluate(() => ({ open: document.querySelector('#side .row[aria-current="true"]')?.dataset.id, words: [...document.querySelectorAll("#scroll .u")].map((u) => u.textContent) }));
  assert.equal(shown.open, older.sessionId, "the conversation opened meanwhile stays open");
  assert.ok(shown.words.some((w) => w.includes("older talk")), shown.words.join(" | "));

  // The answer is not lost: the Trunk's row goes back to the newest conversation, which has it.
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  await page.locator("#scroll .u", { hasText: "slow words" }).waitFor();
  assert.deepEqual(errors, []);
});

test("New conversation starts fresh in the same timeline, under a new line, never as a new row", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  const before = await app.runtime.run({ prompt: "earlier words", trunkId: home.id });
  const { page, errors } = await open(t, app, root);
  const rows = () => page.locator("#side .row[data-line]").count();
  const count = await rows();
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  await page.locator("#scroll").locator(".u", { hasText: "earlier words" }).waitFor();
  const lines = await page.locator("#scroll .tl-sep19").count();

  await page.locator('[data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.locator("#scroll .tl-sep19:not([data-tl])").waitFor();
  assert.equal(await page.locator(".empty-chat").count(), 0, "the timeline stays, not an empty page");
  assert.equal(await page.locator("#scroll").locator(".u", { hasText: "earlier words" }).count(), 1, "the conversation before stays in place");
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).getAttribute("aria-current"), "true");

  const sent = runBody(page);
  await page.locator("#prompt").fill("fresh words");
  await page.keyboard.press("Enter");
  assert.equal((await sent).sessionId, undefined, "a new session for a new context");
  await page.locator("#scroll").locator(".u", { hasText: "fresh words" }).waitFor();
  const fresh = app.store.recentSessions(app.runtime.owner, 10).sessions.find((s) => s.opening === "fresh words");
  assert.equal(app.trunks.trunkForConversation(fresh.sessionId)?.trunkId, home.id, "the engine keeps it with the default Trunk");
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`), fresh.sessionId);
  assert.equal(await rows(), count, "no new row");
  assert.equal(await page.locator("#scroll .tl-sep19").count(), lines + 1, "one more line in the same timeline");
  assert.equal(await page.locator("#scroll").locator(".u", { hasText: "earlier words" }).count(), 1);
  assert.notEqual(fresh.sessionId, before.sessionId);
  assert.deepEqual(errors, []);
});

test("older conversations are read only when scrolled to", async (t) => {
  const { app, root } = await fixture(t, [long]);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  age(app, home.chatSessionId, 5 * 3600000);
  const oldest = await app.runtime.run({ prompt: "oldest long talk", trunkId: home.id });
  age(app, oldest.sessionId, 4 * 3600000);
  const middle = await app.runtime.run({ prompt: "middle long talk", trunkId: home.id });
  age(app, middle.sessionId, 3 * 3600000);
  await app.runtime.run({ prompt: "newest long talk", trunkId: home.id });
  const { page, errors, reads } = await open(t, app, root, { width: 1100, height: 640 });
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  const thread = page.locator("#scroll");
  await thread.locator(".u", { hasText: "newest long talk" }).waitFor();
  await thread.locator(".u", { hasText: "middle long talk" }).waitFor(); // the one just before is read at once
  assert.equal(reads.includes(`/api/sessions/${oldest.sessionId}`), false, "not read before it is scrolled to");
  for (let i = 0; i < 20 && !(await thread.locator(".u", { hasText: "oldest long talk" }).count()); i++) {
    await page.locator("#scroll").evaluate((box) => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(150);
  }
  assert.ok(reads.includes(`/api/sessions/${oldest.sessionId}`), "read once scrolled to");
  assert.equal(await thread.locator(".u", { hasText: "oldest long talk" }).count(), 1);
  assert.ok(await page.locator("#scroll").evaluate((box) => box.scrollTop > 0), "the reader keeps their place, not thrown to the top");
  assert.deepEqual(errors, []);
});

/* CI flake (runs 36574033111, 36636445522): opened, the thread is short until its reads land, and a short thread reads
   further back on a timer. On a busy machine the timer ran after the conversation above had been read, and read the
   one above that as well, before anyone scrolled. Here every zero-delay timer is held back until the reads have landed
   and been drawn, which is that busy machine every time. */
test("a short thread's check that runs late does not read further back than the window needs", async (t) => {
  const { app, root } = await fixture(t, [long]);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  age(app, home.chatSessionId, 5 * 3600000);
  const oldest = await app.runtime.run({ prompt: "oldest long talk", trunkId: home.id });
  age(app, oldest.sessionId, 4 * 3600000);
  const middle = await app.runtime.run({ prompt: "middle long talk", trunkId: home.id });
  age(app, middle.sessionId, 3 * 3600000);
  await app.runtime.run({ prompt: "newest long talk", trunkId: home.id });
  const { page, errors, reads } = await open(t, app, root, { width: 1100, height: 640 });
  await page.evaluate(() => {
    const real = window.setTimeout, late = window.lateTimers = { held: [], ran: new Set(), next: 0 }, fetch = window.fetch;
    window.readsAsked = [];
    window.fetch = (url, ...rest) => { window.readsAsked.push(String(url)); return fetch(url, ...rest); };
    window.setTimeout = (fn, ms, ...args) => {
      if (ms) return real(fn, ms, ...args);
      const id = ++late.next;
      late.held.push(() => { try { if (typeof fn === "function") fn(...args); } finally { late.ran.add(id); } });
      return real(() => undefined, 0);
    };
    window.releaseLateTimers = () => { const due = late.held.splice(0); for (const run of due) real(run, 0); return late.next; };
  });
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  const thread = page.locator("#scroll");
  await thread.locator(".u", { hasText: "newest long talk" }).waitFor();
  await thread.locator(".u", { hasText: "middle long talk" }).waitFor();
  const upTo = await page.evaluate(() => window.releaseLateTimers());
  assert.ok(upTo > 0, "the short thread's check was held back");
  await page.waitForFunction((upTo) => Array.from({ length: upTo }, (_, i) => i + 1).every((id) => window.lateTimers.ran.has(id)), upTo);
  // A read starts inside the timer that asks for it (api.js calls fetch at once), so the page's own list is complete here.
  const asked = await page.evaluate(() => window.readsAsked);
  assert.ok(asked.includes(`/api/sessions/${middle.sessionId}`) || reads.includes(`/api/sessions/${middle.sessionId}`), "the conversation just above is read at once");
  assert.equal([...asked, ...reads].some((url) => url.endsWith(`/api/sessions/${oldest.sessionId}`)), false, "the conversation above that is not read before it is scrolled to");
  assert.deepEqual(errors, []);
});

/* CI flake after the timer fix (PR #1079's run, 05:00 UTC): the browser sends a scroll it queued on the next frame, and a
   redraw in that frame had replaced the thread's box. The old box, off the page, reads scrollTop 0, so its scroll looked
   like the reader at the top and read the conversation above. Here the queued scroll and the redraw are made in one step. */
test("a scroll that lands on a thread box a redraw already replaced reads nothing further back", async (t) => {
  const { app, root } = await fixture(t, [long]);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  age(app, home.chatSessionId, 5 * 3600000);
  const oldest = await app.runtime.run({ prompt: "oldest long talk", trunkId: home.id });
  age(app, oldest.sessionId, 4 * 3600000);
  const middle = await app.runtime.run({ prompt: "middle long talk", trunkId: home.id });
  age(app, middle.sessionId, 3 * 3600000);
  await app.runtime.run({ prompt: "newest long talk", trunkId: home.id });
  const { page, errors, reads } = await open(t, app, root, { width: 1100, height: 640 });
  await page.locator(`#side .row[data-line="${home.id}"]`).click();
  const thread = page.locator("#scroll");
  await thread.locator(".u", { hasText: "newest long talk" }).waitFor();
  await thread.locator(".u", { hasText: "middle long talk" }).waitFor();
  const { replaced, asked } = await page.evaluate(async () => {
    const asked = [], fetch = window.fetch;
    window.fetch = (url, ...rest) => { asked.push(String(url)); return fetch(url, ...rest); }; // api.js calls fetch at once
    const { renderNow } = await import("/app/core/dom.js"), { S } = await import("/app/core/state.js");
    const box = document.querySelector("#scroll");
    box.scrollTop -= 50; // a scroll the browser sends on the next frame
    S.view = "settings"; renderNow(); S.view = "chat"; renderNow(); // the conversation drawn anew, in a new box
    const gone = !box.isConnected && document.querySelector("#scroll") !== box;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); // the queued scroll is sent
    window.fetch = fetch;
    return { replaced: gone, asked };
  });
  assert.equal(replaced, true, "the box the scroll was queued on was replaced");
  assert.equal([...asked, ...reads].some((url) => url.endsWith(`/api/sessions/${oldest.sessionId}`)), false, "the conversation above is not read by a scroll on a box off the page");
  assert.deepEqual(errors, []);
});

test("a conversation's line deletes and restores just that conversation; the row pins the Trunk", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  await app.trunks.introduced();
  const older = await app.runtime.run({ prompt: "older words", trunkId: home.id });
  age(app, older.sessionId, 3600000);
  const newest = await app.runtime.run({ prompt: "newest words", trunkId: home.id });
  const { page, errors } = await open(t, app, root);
  const row = page.locator(`#side .row[data-line="${home.id}"]`);
  await row.click();
  await page.locator("#scroll").locator(".u", { hasText: "older words" }).waitFor();

  // Delete the older conversation from its own line: it leaves the timeline, the row stays.
  await page.locator(`.tl-sep19[data-tl="${older.sessionId}"] [data-act="tl-menu"]`).click();
  await page.locator(`.pop [data-act="conv-delete"][data-id="${older.sessionId}"]`).click();
  await page.locator(`.tl-sep19[data-tl="${older.sessionId}"]`).waitFor({ state: "detached" });
  assert.equal(await page.locator("#scroll").locator(".u", { hasText: "older words" }).count(), 0);
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).count(), 1);
  // Recently Deleted keeps it, and Restore brings it back into the same timeline, not as a row.
  await page.locator('[data-act="putaway"][data-v="deleted"]').click();
  await page.locator(`[data-act="conv-restore"][data-id="${older.sessionId}"]`).click();
  await page.locator(`.tl-sep19[data-tl="${older.sessionId}"]`).waitFor();
  assert.equal(await page.locator(`#side .row[data-id="${older.sessionId}"]`).count(), 0);

  // Deleting the conversation the box sends to moves the box on to the Trunk's next one.
  await page.locator(`.tl-sep19[data-tl="${newest.sessionId}"] [data-act="tl-menu"]`).click();
  await page.locator(`.pop [data-act="conv-delete"][data-id="${newest.sessionId}"]`).click();
  await page.locator(`.tl-sep19[data-tl="${newest.sessionId}"]`).waitFor({ state: "detached" });
  await page.waitForFunction((id) => document.querySelector("#side .row[data-line]")?.dataset.id !== id, newest.sessionId);
  const sent = runBody(page);
  await page.locator("#prompt").fill("after the delete");
  await page.keyboard.press("Enter");
  const to = (await sent).sessionId;
  assert.ok(to && to !== newest.sessionId, "sent to the Trunk's next conversation");
  assert.equal(app.trunks.trunkForConversation(to)?.trunkId, home.id);

  // Pin to top pins the Trunk: its one row moves under Pinned.
  await page.locator(`#side .row[data-line="${home.id}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="tl-pin"][data-id="${home.id}"]`).click();
  await page.waitForFunction((id) => { const row = document.querySelector(`#side .row[data-line="${id}"]`); let h = row?.closest(".rw18")?.previousElementSibling; while (h && !h.classList.contains("lh")) h = h.previousElementSibling; return h?.textContent.trim() === "Pinned"; }, home.id);
  assert.equal(app.trunks.records.get(home.id).pinned, true);
  assert.equal(await page.locator(`#side .row[data-line="${home.id}"]`).count(), 1);
  assert.deepEqual(errors, []);
});
