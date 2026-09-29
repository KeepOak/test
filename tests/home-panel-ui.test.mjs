/**
 * RES-701, from OpenClaw 2.0: the Home panel opens the default Trunk (here, with no default Trunk named, whoever answers
 * a new conversation) beside any page. Its "Working on" snapshot names the page the person is on and the words they
 * selected there; its eye shows exactly what is sent, its x leaves it out, and the engine's own record of the message
 * says which happened. The full-page button opens the panel's conversation as the page with the draft in the box and
 * the snapshot still attached. A real engine and window, a scripted model, a hidden browser.
 * Simple (RES-704) closes the panel and Advanced opens it again only if it was open.
 * Mutation: send the words without the snapshot, keep sending it after its x, drop the draft on the way to the full
 * page, leave the panel open under Simple or open a shut one on the way back, and it goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings, readConversationMode } from "../dist/conversation-mode.js";

async function fixture(t, newConversation = "follow") {
  const root = await mkdtemp(join(tmpdir(), "branch-home-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 880 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}
/** The conversations the owner's tasks ran in, oldest first, and every message the owner sent in them. */
const sessions = (app) => [...new Set(app.store.runs(app.runtime.owner).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.sessionId))];
const sent = (app) => sessions(app).flatMap((id) => app.store.messages(id)).filter((m) => m.role === "user").map((m) => m.content);
const until = async (check, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) { const got = await check(); if (got) return got; if (Date.now() > end) return got; await new Promise((r) => setTimeout(r, 100)); }
};
async function openSettingsPage(page, id) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(`.set-nav .nav[data-v="${id}"]`).click();
  await page.locator(`.set-nav .nav[data-v="${id}"][aria-current="true"]`).waitFor();
  return (await page.locator(`.set-nav .nav[data-v="${id}"]`).textContent()).trim();
}
const panel = (page) => page.locator("#home19 .hm19");

test("beside a Settings page, the snapshot names the page and the selected words, shows what is sent, and the engine gets exactly that", async (t) => {
  const { app, page, errors } = await fixture(t);
  const name = await openSettingsPage(page, "appearance");
  const picked = await page.locator(".set-col h2, .set-col h3, .set-col b").first().evaluate((node) => {
    const range = document.createRange(); range.selectNodeContents(node);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return String(sel).replace(/\s+/g, " ").trim();
  });
  await page.locator('.titlebar [data-act="home19"]').click();
  await panel(page).waitFor();
  const chip = page.locator(".hm19-snap");
  assert.match(await chip.textContent(), new RegExp(`Settings › ${name}`), "the chip names the page");
  await chip.locator('[data-act="home19-see"]').click();
  const shown = await page.locator(".hm19-sent").textContent();
  assert.equal(shown, `Working on: Settings › ${name}\nSelected: “${picked}”`, "the eye shows exactly what goes in front");

  await page.locator("#home19-prompt").fill("What does this page change?");
  await page.locator("#home19-prompt").press("Enter");
  await panel(page).locator(".b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  assert.ok(sent(app).includes(`${shown}\n\nWhat does this page change?`), "the engine got the snapshot and the words");
  assert.ok(await page.locator(`.set-nav .nav[data-v="appearance"][aria-current="true"]`).isVisible(), "the person is still on the page");
  assert.deepEqual(errors, []);
});

test("the snapshot's x leaves it out: the engine gets only the words", async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.locator('#side [data-act="view"][data-v="library"]').click();
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator(".hm19-snap").waitFor();
  await page.locator('[data-act="home19-drop"]').click();
  await page.waitForFunction(() => !document.querySelector(".hm19-snap"));
  await page.locator("#home19-prompt").fill("Only these words");
  await page.locator("#home19-prompt").press("Enter");
  await panel(page).locator(".b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  assert.deepEqual(sent(app), ["Only these words"]);
  assert.deepEqual(errors, []);
});

test("the full-page button opens the panel's conversation as the page, with the draft in the box and the snapshot attached", async (t) => {
  const { app, page, errors } = await fixture(t);
  const name = await openSettingsPage(page, "appearance");
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator("#home19-prompt").fill("First question");
  await page.locator("#home19-prompt").press("Enter");
  await panel(page).locator(".b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  const first = await until(() => sessions(app)[0]);

  await page.locator("#home19-prompt").fill("Carry this draft");
  await page.locator('#home19 [data-act="home19-full"]').first().click();
  await page.waitForFunction(() => document.getElementById("home19").hidden);
  assert.equal(await page.locator("#prompt").inputValue(), "Carry this draft", "the draft is in the full page's box");
  assert.match(await page.locator(".hm19-carried").textContent(), new RegExp(`Settings › ${name}`), "the snapshot is still attached");
  await page.locator("#conversation .b .txt").filter({ hasText: "Noted." }).first().waitFor();
  await page.locator("#send").click();
  await until(() => sent(app).length === 2);
  assert.deepEqual(sessions(app), [first], "it carried on in the panel's own conversation");
  assert.equal(sent(app)[1], `Working on: Settings › ${name}\n\nCarry this draft`);
  await page.waitForFunction(() => !document.querySelector(".hm19-carried"));
  assert.deepEqual(errors, []);
});

test("the panel's new conversation starts under the owner's new-conversation mode, never looser", async (t) => {
  const { app, page, errors } = await fixture(t, "ask");
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator("#home19-prompt").fill("Hello from the panel");
  await page.locator("#home19-prompt").press("Enter");
  await panel(page).locator(".b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  const [sid] = sessions(app);
  assert.equal(readConversationMode(app.store, app.runtime.owner, sid)?.mode, "ask", "the owner's Ask first holds for it");
  assert.deepEqual(errors, []);
});

test("a file attached in the panel stays in the panel's box, and goes with the draft to the full page and then with its message", async (t) => {
  const { app, page, errors } = await fixture(t);
  await page.locator('.titlebar [data-act="home19"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-act="home19-attach"]').click();
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("the notes") });
  await page.locator('#home19-attached .att.ready[data-kind="text"]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#attached .att").count(), 0, "the conversation's own box does not show it");
  await page.locator("#home19-prompt").fill("Read this");
  await page.locator('#home19 [data-act="home19-full"]').first().click();
  await page.waitForFunction(() => document.getElementById("home19").hidden);
  assert.equal(await page.locator("#prompt").inputValue(), "Read this");
  await page.locator("#attached .att.ready").waitFor();
  await page.locator("#send").click();
  const sid = await until(() => sessions(app)[0]);
  const sent = await until(() => app.store.messages(sid).find((m) => m.role === "user"));
  assert.match(sent.content, /Read this/);
  assert.equal(sent.attachments?.[0]?.name, "notes.txt", "the file went with the message");
  assert.deepEqual(errors, []);
});

test("a row picked on the page (a task in Inbox › History) is part of the snapshot, named by its kind and title", async (t) => {
  const { app, page, errors } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "Reconcile the September receipts");
  app.store.finish(run.id, "completed", "Done.");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator('[data-act="ptab"][data-place="inbox"][data-v="history"]').click();
  const row = page.locator("#main .prow").filter({ hasText: "Reconcile the September receipts" });
  await row.locator("b").click();
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator('[data-act="home19-see"]').click();
  const shown = await page.locator(".hm19-sent").textContent();
  assert.match(shown, /Selected task: Reconcile the September receipts/, "the task row is in what is sent");
  await page.locator("#home19-prompt").fill("Is this one finished?");
  await page.locator("#home19-prompt").press("Enter");
  await page.locator("#home19 .b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  assert.ok(sent(app).includes(`${shown}\n\nIs this one finished?`), "the engine got it");
  assert.deepEqual(errors, []);
});

test("the panel is the default Trunk's: named and faced as it, and it writes in that Trunk's own conversation", async (t) => {
  const { app, page, errors } = await fixture(t);
  const trunks = await page.evaluate(async () => (await fetch("/api/trunks", { headers: { authorization: `Bearer ${sessionStorage.getItem("branch-token") ?? ""}` } })).json());
  const home = trunks.trunks.find((tr) => tr.id === trunks.defaultId);
  assert.ok(home?.chatSessionId, "the engine names a default Trunk with its own conversation");
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator(".hm19-h b").filter({ hasText: home.name }).waitFor();
  assert.ok(await page.locator(".hm19-h .av").count(), "it wears the Trunk's own face");
  await page.locator("#home19-prompt").fill("Hello default Trunk");
  await page.locator("#home19-prompt").press("Enter");
  await page.locator("#home19 .b .txt").filter({ hasText: "Noted." }).waitFor({ timeout: 60000 });
  assert.ok(app.store.messages(home.chatSessionId).some((m) => m.role === "user" && m.content.endsWith("Hello default Trunk")), "the words went to the default Trunk's conversation");
  assert.deepEqual(errors, []);
});

test("Simple closes the panel and Advanced opens it again, and a panel shut before Simple stays shut", async (t) => {
  const { page, errors } = await fixture(t);
  const simple = page.locator('[data-act="simple19"]');
  await page.locator('.titlebar [data-act="home19"]').click();
  await panel(page).waitFor();
  await simple.click();
  await page.locator("#app.simple19").waitFor();
  assert.ok(await page.locator("#home19").isHidden(), "Simple puts the panel away");
  await simple.click();
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("simple19"));
  await panel(page).waitFor();
  assert.equal(await page.locator('.titlebar [data-act="home19"]').getAttribute("aria-pressed"), "true", "the panel is open again");

  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator("#home19").waitFor({ state: "hidden" });
  await simple.click();
  await page.locator("#app.simple19").waitFor();
  await simple.click();
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("simple19"));
  assert.ok(await page.locator("#home19").isHidden(), "a panel shut before Simple is not opened by Advanced");
  assert.deepEqual(errors, []);
});
