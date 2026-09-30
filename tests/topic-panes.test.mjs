/* FQ-surfaces.panes: "Compare topics side by side" (public/topic-panes.js, public/topic-panes.css).
   Headless only. Two conversations (topics) are opened as columns and messages must stay assigned
   to the topic they came from, even when the columns' own reads settle out of order. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-topic-panes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/** A finished two-message conversation about the given thing, so two topics never share any words. */
function seedTopic(app, thing) {
  const run = app.store.createRun(app.runtime.owner, `Tell me about ${thing}`);
  app.store.message(run.sessionId, { role: "user", content: `Tell me about ${thing}` });
  app.store.message(run.sessionId, { role: "assistant", content: `Here is what I know about ${thing}.` });
  app.store.finish(run.id, "completed", `Here is what I know about ${thing}.`);
  return run.sessionId;
}

/* ---------------------------------------------------------------- wired into the product */

/* ---------------------------------------------------------------- the new window */
/* Redesign: "Compare topics side by side" is replaced by the prototype's "Open another conversation beside" in the
   conversation's menu (public/app/chat/beside.js): one other conversation read with GET /api/sessions/{id}, drawn next
   to the open one on a wide window, with Open and a close button. What is still proved: each side shows only its own
   conversation's messages, even when an earlier read settles last. */
async function newWindow(t) {
  const { app, root } = await world(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  // The first-run card (#323) takes every click; these tests are about the conversation beside.
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  return { app, server, browser };
}
async function signIn(f) {
  const page = await f.browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}
async function openBeside(page, id) {
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="beside15"]:not([data-v])').click();
  await page.locator(`.pop [data-act="beside15"][data-v="${id}"]`).click();
}

test("the conversation menu opens another conversation beside, and each side shows only its own messages", async (t) => {
  const f = await newWindow(t);
  const cherries = seedTopic(f.app, "cherries");
  const plums = seedTopic(f.app, "plums");
  const { page, errors } = await signIn(f);
  await page.locator(`#side [data-act="chat"][data-id="${plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await openBeside(page, cherries);
  const aside = page.locator("aside.beside15");
  await aside.getByText("Here is what I know about cherries.").waitFor();
  assert.doesNotMatch(await aside.locator(".bs-body15").innerText(), /plums/, "the cherries side never shows the plums conversation");
  assert.doesNotMatch(await page.locator("#conversation").innerText(), /cherries/, "and the open one never shows cherries");
  await aside.getByRole("button", { name: "Close the conversation beside" }).click();
  await aside.waitFor({ state: "detached" });
  assert.match(await page.locator("#conversation").innerText(), /plums/, "closing it leaves the open conversation as it was");
  assert.deepEqual(errors, []);
});

test("the conversation beside keeps its own messages when the one picked before it is read last", async (t) => {
  const f = await newWindow(t);
  const cherries = seedTopic(f.app, "cherries");
  const pears = seedTopic(f.app, "pears");
  const plums = seedTopic(f.app, "plums");
  const { page, errors } = await signIn(f);
  // The cherries conversation is read well after the pears one, so a late answer for an earlier pick would land in
  // (or wipe) the conversation now beside.
  await page.route(`**/api/sessions/${cherries}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.locator(`#side [data-act="chat"][data-id="${plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await openBeside(page, cherries);
  await openBeside(page, pears);
  const aside = page.locator("aside.beside15");
  await aside.getByText("Here is what I know about pears.").waitFor();
  await page.waitForTimeout(2500); // the cherries answer has come back by now
  // WINDOW BUG: public/app/chat/beside.js load() keeps whichever read comes back last (V.id/V.messages), so the late
  // cherries answer replaces pears and the side beside goes blank.
  const text = await aside.locator(".bs-body15").innerText();
  assert.match(text, /Here is what I know about pears\./, "the conversation beside still shows its own messages");
  assert.doesNotMatch(text, /cherries/, "and never the earlier pick's");
  assert.deepEqual(errors, []);
});

/* ---------------------------------------------------------------- messages stay with the right topic */

/* ---------------------------------------------------------------- Escape closes only the sheet */

/* ---------------------------------------------------------------- Escape closes only the picker */


/* ---------------------------------------------------------------- UP-UI-013: live and searchable */

test("UP-UI-013: the conversation beside stays live, and its picker finds any conversation, not only the newest eight", async (t) => {
  const f = await newWindow(t);
  const oldest = seedTopic(f.app, "quinces");
  for (const thing of ["apples", "figs", "grapes", "kiwis", "limes", "mangos", "melons", "olives", "peaches", "pears", "lemons"]) seedTopic(f.app, thing);
  const plums = seedTopic(f.app, "plums");
  const { page, errors } = await signIn(f);
  await page.locator(`#side [data-act="chat"][data-id="${plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="beside15"]:not([data-v])').click();
  await page.locator("#beside-query").fill("quinces");
  const hit = page.locator(`.pop [data-act="beside15"][data-v="${oldest}"]`);
  await hit.waitFor();
  assert.equal(await page.locator('.pop [data-act="beside15"][data-v]').count(), 1, "only the match is listed");
  await hit.click();
  const aside = page.locator("aside.beside15");
  await aside.getByText("Here is what I know about quinces.").waitFor();
  // Work goes on in the conversation beside; its new answer shows there without picking it again.
  await f.app.runtime.run({ prompt: "One more thing about quinces", sessionId: oldest });
  await aside.getByText("Here is a short answer.").waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
});
