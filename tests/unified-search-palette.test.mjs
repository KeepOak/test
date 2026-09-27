/**
 * FQ-collaboration.unified-search: the palette (Ctrl K / the top-bar "Search" box) is where the
 * owner actually reaches GET /api/search (src/unified-search.ts, public/unified-search.js). This
 * proves a query that matches nothing local still surfaces a conversation, a workflow and an audit
 * (repository) result, each opening the real place its source lives — not just that the route answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-unified-search-palette-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) }); // the first-run card (#323) is not what this is about
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });

  const word = "quokkabridge7000";
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "Unified search palette fixture");
  app.store.message(run.sessionId, { role: "user", content: `Notes mentioning ${word} here.` });
  app.store.finish(run.id, "completed", "Fixture complete");
  // A recent conversation whose title does not carry the word, only a later message: the palette's
  // local title match cannot find it, so only /api/search can.
  const quiet = app.store.createRun(owner, "Plan the trip");
  app.store.message(quiet.sessionId, { role: "user", content: "Plan the trip" });
  app.store.message(quiet.sessionId, { role: "assistant", content: `Pack the ${word} adapter first.` });
  app.store.finish(quiet.id, "completed", "Fixture complete");
  const workflow = app.workflows.create(owner, {
    name: `Palette workflow ${word}`,
    description: `A saved workflow used only to test ${word} in the palette.`,
    steps: [{ name: "Say hello", kind: "prompt", prompt: "Say hello." }],
  });
  app.store.audit.record(owner, {
    action: "data.exported", actor: owner, subject: `export touching ${word}`,
    reason: "Palette fixture for unified search", outcome: "saved",
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, word, sessionId: run.sessionId, quietId: quiet.sessionId, workflow };
}

/* Redesign: in the new window the engine's search (GET /api/search) is reached from the sidebar's Search box
   (shell/search.js, 1:1 with prototype.html): Chats and Trunks by title, Messages by the words inside a conversation
   (the engine's conversation results), Past sessions and Files. Ctrl K's palette (shell/palette.js) finds actions,
   conversation titles, places and settings pages only, as the prototype's does. */
async function searchFor(page, word) {
  await page.locator("#side-q").fill(word);
  await page.locator(".list.searching9").waitFor({ state: "visible" });
}
const messageRow = (page, id) => page.locator(`#side [data-act="sr-msg"][data-id="${id}"]`);

test("a conversation result opens the conversation", async (t) => {
  const { page, errors, word, sessionId } = await fixture(t);
  await searchFor(page, word);
  // "Notes mentioning …" is the fixture message itself, found by its words through /api/search.
  const item = messageRow(page, sessionId);
  await item.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await item.innerText(), /Notes mentioning/);
  await item.click();
  await page.locator("#conversation").getByText(`Notes mentioning ${word} here.`).first().waitFor({ timeout: 10000 });
  await page.locator("#side-q").fill("");
  await page.waitForFunction((id) => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id === id, sessionId);
  assert.deepEqual(errors, []);
});

test("a one-letter query never reaches the remote search, but the full word does", async (t) => {
  const { page, word, quietId } = await fixture(t);
  const asked = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === "/api/search") asked.push(url.searchParams.get("q")); });
  await page.locator("#side-q").fill(word[0]);
  await page.waitForTimeout(600);
  const early = [...asked];
  await page.locator("#side-q").fill(word);
  await messageRow(page, quietId).waitFor({ state: "visible", timeout: 10000 });
  assert.ok(asked.includes(word), "the full word is searched");
  assert.deepEqual(early, [], "one letter is too short to search remotely");
});

test("a recent conversation whose title lacks the word is still found by its words, and opens", async (t) => {
  const { page, errors, word, quietId } = await fixture(t);
  await searchFor(page, word);
  const item = messageRow(page, quietId);
  await item.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('#side [data-act="chat"]', { hasText: "Plan the trip" }).count(), 0, "its title did not match locally");
  await item.click();
  await page.locator("#conversation").getByText(`Pack the ${word} adapter first.`).first().waitFor({ timeout: 10000 });
  await page.locator("#side-q").fill("");
  await page.waitForFunction((id) => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id === id, quietId);
  assert.deepEqual(errors, []);
});

test("the search lists a conversation once even if the engine answers with two rows for it", async (t) => {
  const { page, word, quietId } = await fixture(t);
  // The server already groups by conversation; this feeds the window a repeated row directly, so
  // its own de-duplication is what is being checked.
  const row = { kind: "conversation", title: `Conversation ${quietId.slice(0, 8)}`,
    snippet: `Pack the ${word} adapter first.`, link: `/api/sessions/${quietId}` };
  await page.route("**/api/search?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ results: [row, { ...row }] }),
  }));
  await searchFor(page, word);
  const item = messageRow(page, quietId);
  await item.first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  assert.equal(await item.count(), 1);
});

test("Ctrl K's palette finds a conversation by its title and opens it", async (t) => {
  const { page, errors, sessionId } = await fixture(t);
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  await page.locator("#pal-in").fill("Notes mentioning");
  // A conversation is named by its opening words; the engine's search inside conversations can add a second row for the
  // same words a moment later, so the first row (the conversation's own) is the one pressed.
  const item = page.locator('#pal-list [data-act="pal"]', { hasText: "Notes mentioning" }).first();
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator("#pal-in").waitFor({ state: "detached" });
  await page.waitForFunction((id) => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id === id, sessionId);
  assert.deepEqual(errors, []);
});
