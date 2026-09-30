/* Models and accounts in the window (owner priority 2026-09-27): a Trunk's own Accounts tab picks its account per
   connection and carries "Use my accounts too" (keys.copyFromOwner), each saved in the engine and still there after a
   reload; Settings › Models › Second opinion is wired to the engine's advisor (src/second-opinion.ts) and never resets
   the fields it does not show; Media offers the picture models the connection that answers can make, and stays greyed
   with its reason when that connection has no picture route. Every service is a stand-in; headless, 127.0.0.1.
   Mutation: drop the "accounts" tab from flows/trunk.js drawEditor, or send only { advisor } from models.js setSecond,
   and a case here goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode } from "../dist/accounts/manage.js";
import { sessionChoice } from "../dist/accounts/settings.js";
import { gselChoices, pickGsel } from "./gsel.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t, { pictures = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-accounts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const owner = app.runtime.owner;
  /* A saved key connection with a second key, as src/accounts keeps them. */
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const provider = { name: "openai-chat", complete: quiet.complete,
    ...(pictures ? { images: () => ({ kind: "openai", endpoint: "http://127.0.0.1:9/v1", apiKey: "k", defaultModel: "gpt-image-1" }) } : {}) };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider });
  if (pictures) app.runtime.models.configure(owner, { activePreset: POOL });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy;
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second key", key: SECOND_KEY })).accounts.find((a) => a.label === "Second key").id;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Ada", title: "Test", description: "" });
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, owner, page, errors, call, trunk, second };
}

async function openAccounts(page, id) {
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator(`.prow [data-act="edit"][data-id="${id}"]`).click();
  await page.waitForSelector(".dlg .editor");
  await page.locator('.dlg [data-act="st-tab"][data-v="accounts"]').click();
  await page.waitForSelector(`.dlg [data-tk-pool="${POOL}"]:not(.soon)`);
}
async function reload(page) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
async function openModels(page, tab) {
  if (!(await page.locator(".settings").count())) await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator('[data-act="setpage"][data-v="models"][aria-current="true"]').waitFor();
  await page.locator(`[data-act="mtab"][data-v="${tab}"]`).click();
  await page.waitForTimeout(1200); // the page's own read of the engine, and its redraw
}

test("Edit Trunk › Accounts: an account picked for a connection is saved, reaches its chat and is still picked after a reload", async (t) => {
  const { app, owner, page, errors, call, trunk, second } = await fixture(t);
  await openAccounts(page, trunk.id);
  const select = page.locator(`.dlg [data-tk-pool="${POOL}"]`);
  assert.equal(await select.getAttribute("value"), "", "nothing is picked at first: it uses the owner's accounts");
  assert.match((await gselChoices(select))[0].words, /Your accounts/);
  assert.ok(await page.locator(".dlg #tk-copy").isChecked(), "Use my accounts too ships on");
  assert.match(await page.locator(".dlg .tk-pool b").first().textContent(), /OpenAI test/, "the connection is named, not its id");
  assert.equal(await page.locator(".dlg .tk-uses").count(), 0, "no model picked yet: no connection is marked");

  /* The model and its account in one place: picking the connection here marks it as the one the Trunk answers with. */
  await pickGsel(page.locator(".dlg #tm-model-sel"), POOL);
  await waitFor(async () => (await call(`/api/trunks/${trunk.id}`)).trunk.model === POOL);
  await page.waitForSelector(`.dlg .tk-uses`);
  assert.match(await page.locator(".dlg .tk-pool").first().textContent(), /OpenAI test.*Answers with this/s);

  await pickGsel(page.locator(`.dlg [data-tk-pool="${POOL}"]`), second);
  await waitFor(async () => (await call(`/api/trunks/${trunk.id}`)).trunk.keys.accounts[POOL] === second);
  const { trunk: saved } = await call(`/api/trunks/${trunk.id}`);
  assert.deepEqual(saved.keys, { copyFromOwner: true, accounts: { [POOL]: second } }, "the rest of keys is carried over");
  assert.equal(sessionChoice(app.store, owner, saved.chatSessionId)[POOL], second, "the pick is the Trunk chat's own account");

  await reload(page);
  await openAccounts(page, trunk.id);
  assert.equal(await page.locator(`.dlg [data-tk-pool="${POOL}"]`).getAttribute("value"), second);

  /* Where it goes when its pick runs out: saved as keys.next, with the pick and "Use my accounts too" kept. */
  const then = page.locator(`.dlg [data-tk-next="${POOL}"]`);
  assert.deepEqual((await gselChoices(then)).map((c) => c.value), ["", "primary"], "only the connection's other accounts");
  await pickGsel(then, "primary");
  await waitFor(async () => (await call(`/api/trunks/${trunk.id}`)).trunk.keys.next?.[POOL]?.[0] === "primary");
  assert.deepEqual((await call(`/api/trunks/${trunk.id}`)).trunk.keys, { copyFromOwner: true, accounts: { [POOL]: second }, next: { [POOL]: ["primary"] } });
  await page.keyboard.press("Escape");

  /* When its work moves on at a limit, the owner is told which account took it. */
  accountsServiceFor(app.runtime.models).trunkMoves.unshift({ sessionId: saved.chatSessionId, pool: POOL, name: "OpenAI test",
    from: "Second key", to: "Your key", why: "Second key reached its plan limit.", at: new Date().toISOString() });
  const moving = app.store.createRun(owner, "hello");
  app.store.event(moving.id, "model.account_moved", {}); // the window reads its state again on the engine's events, as when it moves
  const card = page.locator(".notif");
  await card.waitFor({ timeout: 30000 });
  assert.match(await card.innerText(), /Ada[\s\S]*Moved to Your key on OpenAI test: Second key reached its limit\./);

  /* A paused account is listed but cannot be taken. */
  await call("/api/accounts/update", { pool: POOL, account: "primary", disabled: true });
  await reload(page);
  await openAccounts(page, trunk.id);
  const primary = (await gselChoices(page.locator(`.dlg [data-tk-pool="${POOL}"]`))).find((c) => c.value === "primary");
  assert.equal(primary.off, true, "a paused account cannot be picked");
  assert.match(primary.words, /can't answer now/);

  /* Back to no pick: the key goes, and the chat goes back to the owner's default. */
  await pickGsel(page.locator(`.dlg [data-tk-pool="${POOL}"]`), "");
  await waitFor(async () => !(POOL in (await call(`/api/trunks/${trunk.id}`)).trunk.keys.accounts));
  assert.equal(sessionChoice(app.store, owner, saved.chatSessionId)[POOL], undefined);
  assert.deepEqual(errors, []);
});

test("Edit Trunk › Accounts: Use my accounts too round-trips, and with it off the engine's own note says what to pick", async (t) => {
  const { page, errors, call, trunk } = await fixture(t);
  await openAccounts(page, trunk.id);
  await page.locator(".dlg #tk-copy").click();
  await waitFor(async () => (await call(`/api/trunks/${trunk.id}`)).trunk.keys.copyFromOwner === false);
  await page.waitForSelector(".dlg .tk-notes li");
  assert.match(await page.locator(".dlg .tk-notes").textContent(), /OpenAI test: your accounts are not copied, so pick one for this Trunk/);
  assert.match((await gselChoices(page.locator(`.dlg [data-tk-pool="${POOL}"]`)))[0].words, /None, so it doesn't answer/);

  await reload(page);
  await openAccounts(page, trunk.id);
  assert.equal(await page.locator(".dlg #tk-copy").isChecked(), false, "still off after a reload");
  await page.locator(".dlg #tk-copy").click();
  await waitFor(async () => (await call(`/api/trunks/${trunk.id}`)).trunk.keys.copyFromOwner === true);
  await page.waitForFunction(() => !document.querySelector(".dlg .tk-notes"));
  assert.deepEqual(errors, []);
});

test("Settings › Models › Second opinion is live: the switch, who checks and the ceiling are the engine's, and the rest is kept", async (t) => {
  const { app, page, errors, call } = await fixture(t);
  await call("/api/second-opinion", { advisor: false, debateExchanges: 2, debateMaxTokens: 90000 }); // fields this tab does not show
  await openModels(page, "second");
  const sw = page.locator("#m-second");
  assert.equal(await sw.getAttribute("aria-disabled"), null, "not greyed");
  await sw.click();
  await waitFor(async () => (await call("/api/second-opinion")).advisor === true);
  await pickGsel(page.locator("#m-second-by"), POOL); // a glass list: one choice per connection (QA pass 2)
  await waitFor(async () => (await call("/api/second-opinion")).advisorPreset === POOL);
  await page.locator("#m-second-max").fill("9000");
  await page.locator("#m-second-max").press("Tab");
  await waitFor(async () => (await call("/api/second-opinion")).advisorMaxTokens === 9000);
  let kept = await call("/api/second-opinion");
  assert.deepEqual(kept, { advisor: true, advisorPreset: POOL, advisorMaxTokens: 9000, debateExchanges: 2, debateMaxTokens: 90000 });
  /* The debate's own limits, from the same card. */
  assert.equal(await page.locator('[data-act="m-debate-rounds"][data-v="2"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-act="m-debate-rounds"][data-v="3"]').click();
  await waitFor(async () => (await call("/api/second-opinion")).debateExchanges === 3);
  await page.locator("#m-debate-max").fill("120000");
  await page.locator("#m-debate-max").press("Tab");
  await waitFor(async () => (await call("/api/second-opinion")).debateMaxTokens === 120000);
  kept = await call("/api/second-opinion");
  assert.equal(kept.advisorMaxTokens, 9000, "the check's own ceiling is kept");

  await reload(page);
  await openModels(page, "second");
  assert.ok(await page.locator("#m-second").isChecked());
  assert.equal(await page.locator("#m-second-by").getAttribute("value"), POOL);
  assert.equal(await page.locator("#m-second-max").inputValue(), "9000");
  /* The note the switch promises: Look inside reads it from the task's own record (chat/messages.js inspect). */
  const run = await app.runtime.run({ prompt: "hello" });
  const record = await call(`/api/runs/${run.id}/inspect`);
  assert.match(record.advice?.line ?? "", /^OpenAI test is not sure about this\./, "the second opinion's note is on the task's record");
  assert.deepEqual(errors, []);
});

test("Settings › Models › Media: pictures are greyed with their reason when the connection that answers has no picture route", async (t) => {
  const { page, errors } = await fixture(t);
  await openModels(page, "media");
  assert.equal(await page.locator("#m-img").getAttribute("aria-disabled"), "true");
  assert.match(await page.locator("#m-img").getAttribute("data-tip"), /can't make pictures/);
  assert.equal(await page.locator('[data-act="seg"][data-why="m-vid-svc-off"]').first().getAttribute("aria-disabled"), "true", "the video service waits for videos to be on");
  assert.deepEqual(errors, []);
});

test("Settings › Models › Media: a picture model for the connection that answers is saved and kept after a reload", async (t) => {
  const { page, errors, call } = await fixture(t, { pictures: true });
  await call("/api/media/settings", { folder: "pics" }); // a field this tab does not show
  await openModels(page, "media");
  assert.equal(await page.locator('[data-act="m-img"][data-v=""]').getAttribute("aria-pressed"), "true", "the service's own model at first");
  assert.equal(await page.locator('[data-act="m-img"][data-v^="gemini"]').count(), 0, "only models this route can make");
  await page.locator('[data-act="m-img"][data-v="dall-e-3"]').click();
  await waitFor(async () => (await call("/api/media/settings")).settings.imageModel === "dall-e-3");
  assert.equal((await call("/api/media/settings")).settings.folder, "pics", "the folder is kept");
  await reload(page);
  await openModels(page, "media");
  assert.equal(await page.locator('[data-act="m-img"][data-v="dall-e-3"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
});

async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
