/**
 * RES-703 / SELF-308, from Hermes Desktop: one composer, many panes. Conversations are pulled into panes beside the open
 * one (from a row's menu and from the + at the end of the tabs); the pane under the pointer becomes the active one, is
 * marked (its ring, its tab, the box's "to" pill and words) before Enter is pressed, and what is typed goes to that
 * pane's own conversation and to no other, as the engine's records show. Panes are reordered from the keyboard, widened by
 * their handle, closed from their tab, and the layout (the main conversation too) comes back after a reload.
 * A real engine and window, a scripted model, a hidden browser.
 * Simple (RES-704) leaves the main conversation alone and Advanced brings the panes back as they were; Ctrl+Enter
 * (RES-702) while another pane is active writes to that pane, never to a new background conversation.
 * Mutation: send the box to the main conversation whatever the active pane, stop marking the hovered pane, keep the
 * panes under Simple, or let Ctrl+Enter start a background conversation over an active pane, and it goes red.
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
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const echo = { name: "scripted", async complete(request) {
  const last = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
  return { content: `Heard: ${last}`, toolCalls: [] };
} };

function seedTopic(app, thing) {
  const run = app.store.createRun(app.runtime.owner, `Tell me about ${thing}`);
  app.store.message(run.sessionId, { role: "user", content: `Tell me about ${thing}` });
  app.store.message(run.sessionId, { role: "assistant", content: `Here is what I know about ${thing}.` });
  app.store.finish(run.id, "completed", `Here is what I know about ${thing}.`);
  return run.sessionId;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-panes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: echo });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const ids = { apples: seedTopic(app, "apples"), pears: seedTopic(app, "pears"), plums: seedTopic(app, "plums") };
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, ids };
}
const said = (app, id) => app.store.messages(id).filter((m) => m.role === "user").map((m) => m.content);
const pane = (page, id) => page.locator(`.pn19[data-pane="${id}"]`);
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("branch-window") || "{}").panes19);
const order = (page) => page.locator(".pn19[data-pane]").evaluateAll((all) => all.map((p) => p.dataset.pane));

async function threePanes(page, ids) {
  await page.locator(`#side [data-act="chat"][data-id="${ids.plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await page.locator(`#side [data-act="chat"][data-id="${ids.pears}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="pane-add"][data-id="${ids.pears}"]`).click();
  await pane(page, ids.pears).getByText("Here is what I know about pears.").waitFor();
  await page.locator('.tab19 [data-act="pane-pick"]').click();
  await page.locator(`.pop [data-act="beside15"][data-v="${ids.apples}"]`).click();
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
}

test("the hovered pane is marked before Enter, and what is typed goes to that pane's conversation only", async (t) => {
  const { app, page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  assert.equal(await page.locator(".pn19").count(), 3, "three conversations side by side");

  await pane(page, ids.pears).locator(".bs-body15").hover();
  await page.locator(`.pn19.on19[data-pane="${ids.pears}"]`).waitFor();
  assert.equal(await page.locator(".pn19.on19").count(), 1, "one active pane");
  assert.equal(await pane(page, ids.pears).locator(".tab19").getAttribute("aria-current"), "true", "its tab is marked");
  assert.match(await page.locator("#to19").textContent(), /pears/, "the box names it");
  assert.match(await page.locator("#prompt").getAttribute("placeholder"), /pears/);

  await page.locator("#prompt").fill("Pick the ripest pear");
  await page.locator("#prompt").press("Enter");
  await pane(page, ids.pears).getByText("Heard: Pick the ripest pear").waitFor({ timeout: 60000 });
  assert.ok(said(app, ids.pears).includes("Pick the ripest pear"), "the pears conversation got it");
  assert.ok(!said(app, ids.plums).includes("Pick the ripest pear") && !said(app, ids.apples).includes("Pick the ripest pear"), "no other did");

  await pane(page, "@main").locator("#scroll").hover();
  await page.locator('.pn19.on19[data-pane="@main"]').waitFor();
  assert.match(await page.locator("#to19").textContent(), /plums/);
  await page.locator("#prompt").fill("And the plums?");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation").getByText("Heard: And the plums?").waitFor({ timeout: 60000 });
  assert.ok(said(app, ids.plums).includes("And the plums?"));
  assert.ok(!said(app, ids.pears).includes("And the plums?"));
  assert.deepEqual(errors, []);
});

test("panes are reordered, widened and closed, and the layout comes back after a reload", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  assert.deepEqual(await order(page), ["@main", ids.pears, ids.apples]);

  await pane(page, ids.apples).locator(".tab19").focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction((want) => [...document.querySelectorAll(".pn19[data-pane]")].map((p) => p.dataset.pane).join() === want, ["@main", ids.apples, ids.pears].join());

  const handle = page.locator(".pz19").first(), box = await handle.boundingBox();
  const before = await pane(page, "@main").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await pane(page, "@main").boundingBox();
  assert.ok(after.width > before.width + 100, `the main pane widened (${before.width} → ${after.width})`);
  const widths = (await saved(page)).w;
  assert.ok(widths["@main"] > widths[ids.apples], "the widths are kept");

  await pane(page, ids.pears).locator('.tab19 [data-act="pane-x"]').click();
  await pane(page, ids.pears).waitFor({ state: "detached" });
  await pane(page, ids.apples).locator(".bs-body15").hover();
  await page.locator(`.pn19.on19[data-pane="${ids.apples}"]`).waitFor();

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  assert.deepEqual(await order(page), ["@main", ids.apples], "the same panes, in the same order");
  assert.equal(await page.locator(`.pn19.on19[data-pane="${ids.apples}"]`).count(), 1, "the same active pane");
  const again = await pane(page, "@main").boundingBox(), other = await pane(page, ids.apples).boundingBox();
  assert.ok(again.width > other.width, "and the same widths");
  assert.deepEqual(errors, []);
});

test("a pane opened here in full swaps places with the main one, and the box keeps what was written", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  await page.locator("#prompt").fill("Half a thought");
  await pane(page, ids.apples).locator('.tab19 [data-act="pane-main"]').click();
  await page.locator("#conversation").getByText("Here is what I know about apples.").waitFor();
  await pane(page, ids.plums).getByText("Here is what I know about plums.").waitFor();
  assert.deepEqual(await order(page), [ids.plums, ids.pears, "@main"], "the old main conversation took the pane's place");
  assert.equal(await page.locator("#prompt").inputValue(), "Half a thought", "the words stayed in the box");
  assert.deepEqual(errors, []);
});

test("with too little room for every pane, each keeps a readable width and the row scrolls sideways", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  await page.setViewportSize({ width: 1180, height: 860 });
  await page.locator(".panes19.tight19").waitFor();
  for (const id of ["@main", ids.pears, ids.apples]) assert.ok((await pane(page, id).boundingBox()).width >= 299, `${id} keeps its width`);
  assert.ok(await page.locator(".panes19").evaluate((el) => el.scrollWidth > el.clientWidth), "the row scrolls");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForFunction(() => !document.querySelector(".panes19.tight19"));
  assert.deepEqual(errors, []);
});

test("Simple leaves the main conversation alone, and Advanced brings the panes back in their order", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  const before = await order(page);
  const simple = page.locator('[data-act="simple19"]');
  await simple.click();
  await page.locator("#app.simple19").waitFor();
  assert.equal(await page.locator(".pn19").count(), 0, "the main conversation alone");
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await simple.click();
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("simple19"));
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
  assert.deepEqual(await order(page), before, "every pane is back where it was");
  assert.deepEqual(errors, []);
});

test("Ctrl+Enter while another pane is active writes to that pane, not to a new background conversation", async (t) => {
  const { app, page, errors, ids } = await fixture(t);
  await page.locator(".empty-chat").waitFor();
  await page.locator(`#side [data-act="chat"][data-id="${ids.pears}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="pane-add"][data-id="${ids.pears}"]`).click();
  await pane(page, ids.pears).getByText("Here is what I know about pears.").waitFor();
  await pane(page, ids.pears).locator(".bs-body15").hover();
  await page.locator(`.pn19.on19[data-pane="${ids.pears}"]`).waitFor();
  const before = app.store.runs(app.runtime.owner).length;
  await page.locator("#prompt").fill("Which pear first?");
  await page.locator("#prompt").press("Control+Enter");
  await pane(page, ids.pears).getByText("Heard: Which pear first?").waitFor({ timeout: 60000 });
  const runs = app.store.runs(app.runtime.owner);
  assert.equal(runs.length, before + 1, "one task, and no background conversation beside it");
  assert.equal(runs.find((r) => r.prompt === "Which pear first?")?.sessionId, ids.pears, "it went to the pears conversation");
  assert.ok(await page.locator(".empty-chat").isVisible(), "the main conversation is still the new one");
  assert.deepEqual(errors, []);
});

test("Simple pane choices preserve the saved layout, including widths, and a reload restores its main conversation", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  const before = await saved(page), simple = page.locator('[data-act="simple19"]');
  await simple.click();
  await page.locator("#app.simple19").waitFor();
  assert.equal(await page.locator(".pn19").count(), 0);
  assert.deepEqual(await saved(page), before, "hiding panes leaves the saved layout intact");

  await page.locator(`#side [data-act="chat"][data-id="${ids.pears}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="pane-add"][data-id="${ids.pears}"]`).click();
  await pane(page, ids.pears).getByText("Here is what I know about pears.").waitFor();
  const handle = page.locator(".pz19").first(), box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await saved(page), before, "a temporary open and resize do not change workspace preferences");

  await simple.click();
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
  assert.deepEqual(await order(page), before.ids);
  assert.equal(await page.locator(`.pn19.on19[data-pane="${before.active}"]`).count(), 1);
  assert.deepEqual(await saved(page), before);
  await simple.click();
  await page.reload();
  await page.locator("#app.simple19").waitFor();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  assert.equal(await page.locator(".pn19").count(), 0, "reload keeps the extra panes masked");
  assert.deepEqual(await saved(page), before);
  await simple.click();
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
  assert.deepEqual(await order(page), before.ids);
  assert.deepEqual(errors, []);
});

test("legacy Simple snapshots recover the saved pane layout once without persisting a snapshot", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await threePanes(page, ids);
  const before = await saved(page);
  await page.evaluate((layout) => {
    const kept = JSON.parse(localStorage.getItem("branch-window"));
    localStorage.setItem("branch-window", JSON.stringify({ ...kept, simple: true, level: "regular",
      panes19: { ...layout, ids: ["@main"], active: "@main" }, simpleFrom: { level: "technical", panes19: layout } }));
  }, before);
  await page.reload();
  await page.locator("#app.simple19").waitFor();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  assert.equal(await page.locator(".pn19").count(), 0);
  assert.deepEqual(await saved(page), before, "the legacy hidden layout becomes the normal preference");
  assert.equal(await page.evaluate(() => "simpleFrom" in JSON.parse(localStorage.getItem("branch-window"))), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("branch-window")).level), "technical");
  await page.locator('[data-act="simple19"]').click();
  await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
  assert.deepEqual(await order(page), before.ids);
  assert.deepEqual(errors, []);
});

test("an answer arriving for a pending beside-conversation read cannot unfold Simple", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await page.locator(`#side [data-act="chat"][data-id="${ids.plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/sessions/${ids.apples}`, async (route) => { await held; await route.continue(); });
  try {
    const asked = page.waitForRequest((request) => request.url().endsWith(`/api/sessions/${ids.apples}`));
    await page.locator(`#side [data-act="chat"][data-id="${ids.apples}"]`).click({ button: "right" });
    await page.locator(`.pop [data-act="pane-add"][data-id="${ids.apples}"]`).click();
    await asked;
    const before = await saved(page), simple = page.locator('[data-act="simple19"]');
    await simple.click();
    await page.locator("#app.simple19").waitFor();
    const answered = page.waitForResponse((response) => response.url().endsWith(`/api/sessions/${ids.apples}`));
    release();
    await (await answered).finished();
    assert.equal(await page.locator(".pn19").count(), 0, "the delayed answer leaves panes folded");
    assert.deepEqual(await saved(page), before);
    await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
    await simple.click();
    await pane(page, ids.apples).getByText("Here is what I know about apples.").waitFor();
    assert.deepEqual(await order(page), before.ids);
    assert.deepEqual(errors, []);
  } finally { release(); }
});
