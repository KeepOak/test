/**
 * Batch D of the tip audit: the Settings controls that were greyed with no reason or did nothing, opened the way a
 * person opens them and checked through the engine's own routes. A headless browser; the connections are stand-ins, so
 * nothing reaches a provider and no model runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const POOL = "openai-ui";
const KEY = "sk-batch-d-test-00000000"; // not-a-real-secret
const answer = async () => ({ content: "ok", toolCalls: [] });

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-batch-d-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai", provider: { name: "openai-chat", complete: answer } });
  // A connection on this computer: its address is 127.0.0.1 (src/models.ts presetRunsLocally).
  app.runtime.models.register({ id: "here", name: "Here", model: "here-1",
    provider: { name: "ollama", complete: answer, embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1/embeddings" }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  app.store.save("settings", owner, "onboarding", { done: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors, app, owner, call, server };
}
async function signIn({ page, server }) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}
async function settingsPage(page, id, level = "technical") {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(`[data-act="setlevel"][data-v="${level}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
}
const until = async (check, what) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`never happened: ${what}`);
};

test("D1 the account menu renames an account and says which Trunks use it, through the engine", async (t) => {
  const f = await fixture(t);
  const added = await f.call("/api/accounts/add", { pool: POOL, label: "Second", key: KEY });
  const second = added.accounts.at(-1).id;
  const { trunk } = await f.call("/api/trunks", { name: "Scout" });
  assert.ok(trunk?.id, "a Trunk was made");
  await signIn(f);
  await settingsPage(f.page, "accounts");
  const menu = () => f.page.locator(`#main [data-act="acct-menu"][data-pool="${POOL}"][data-id="${second}"]`).click();
  await menu();
  await f.page.locator('.pop [data-act="acct-rename"]').click();
  await f.page.getByLabel("Call it", { exact: true }).fill("Work plan");
  await f.page.locator('.dlg [data-act="acct-rename-save"]').click();
  await until(async () => (await f.call("/api/accounts")).pools.find((p) => p.pool === POOL)?.accounts.some((a) => a.id === second && a.label === "Work plan"), "the engine has the new name");
  await f.page.locator("#main", { hasText: "Work plan" }).waitFor();

  await menu();
  await f.page.locator('.pop [data-act="acct-trunks"]').click();
  const chip = (v) => f.page.locator(`.dlg [data-act="acct-trunk"][data-v="${v}"]`);
  assert.equal(await chip("anyone").getAttribute("aria-pressed"), "true", "no Trunk picks it yet");
  await chip(trunk.id).click();
  await f.page.locator('.dlg [data-act="acct-trunks-save"]').click();
  await until(async () => (await f.call(`/api/trunks/${trunk.id}`)).trunk.keys.accounts[POOL] === second, "the Trunk uses the account");
  const before = (await f.call(`/api/trunks/${trunk.id}`)).trunk.keys.copyFromOwner;

  await menu();
  await f.page.locator('.pop [data-act="acct-trunks"]').click();
  assert.equal(await chip(trunk.id).getAttribute("aria-pressed"), "true", "the Trunk's pick is read back");
  await chip("anyone").click();
  await f.page.locator('.dlg [data-act="acct-trunks-save"]').click();
  await until(async () => !(POOL in (await f.call(`/api/trunks/${trunk.id}`)).trunk.keys.accounts), "the pick is gone");
  assert.equal((await f.call(`/api/trunks/${trunk.id}`)).trunk.keys.copyFromOwner, before, "the rest of the Trunk's keys are kept");
  assert.deepEqual(f.errors, []);
});

test("D2 when one runs out: falling back to this computer is saved in the fallback order; with one account per connection the next-account switch is greyed with its reason", async (t) => {
  const f = await fixture(t);
  await signIn(f);
  await settingsPage(f.page, "accounts");
  const fall = f.page.locator("#main #ac-fall");
  assert.equal(await fall.isChecked(), false, "it ships off: a local model works this computer hard");
  await fall.check();
  await until(async () => (await f.call("/api/state")).models.fallbackOrder.includes("here"), "the model on this computer is in the order");
  await fall.uncheck();
  await until(async () => !(await f.call("/api/state")).models.fallbackOrder.includes("here"), "it is out of the order again");
  const next = f.page.locator('#main input.sw[data-why="ac-next"]');
  assert.equal(await next.isDisabled(), true);
  assert.match(await next.locator("xpath=ancestor::div[contains(@class,'ctl')]").getAttribute("data-why-text"), /add a second account to a connection first/);
  assert.deepEqual(f.errors, []);
});

test("D3 Models › Defaults: each kind of work is the engine's own setting, and Pick the model per task chooses between two of them", async (t) => {
  const f = await fixture(t);
  await signIn(f);
  await settingsPage(f.page, "models");
  await f.page.locator('#main [data-act="mtab"][data-v="defaults"]').click();
  const pick = (k, v) => f.page.locator(`#main [data-act="m-def"][data-k="${k}"][data-v="${v}"]`);
  const byTask = f.page.locator("#main #f15-pick-the-model-per-task");
  assert.equal(await byTask.count(), 0, "greyed while the two picks are not chosen");
  assert.match(await f.page.locator('#main input.sw[data-why="f15-pick-the-model-per-task"]').locator("xpath=ancestor::div[contains(@class,'ctl')]").getAttribute("data-why-text"), /Choose both first under Defaults/);

  await pick("everyday", "here").click();
  await until(async () => (await f.call("/api/state")).models.activePreset === "here", "everyday answers");
  await pick("planning", POOL).click();
  await until(async () => (await f.call("/api/model-savings")).values.phases.planModel === POOL, "planning");
  await pick("quick", "here").click();
  await until(async () => (await f.call("/api/knobs")).values.subtasks.subtaskModel === "here", "quick jobs");
  await pick("summaries", "here").click();
  await until(async () => (await f.call("/api/knobs")).values.subtasks.sideJobModel === "here", "summaries");
  await until(async () => (await pick("summaries", "here").getAttribute("aria-pressed")) === "true", "drawn pressed");
  await pick("summaries", "here").click();
  await until(async () => (await f.call("/api/knobs")).values.subtasks.sideJobModel === null, "pressing it again goes back to the conversation's own");

  await byTask.check();
  await until(async () => {
    const d = (await f.call("/api/model-savings")).values.difficulty;
    return d.mode === "when-needed" && d.easyModel === "here" && d.hardModel === POOL;
  }, "easy goes to the quick pick, hard to the planning pick");
  await pick("planning", "here").click();
  await until(async () => (await f.call("/api/model-savings")).values.difficulty.hardModel === "here", "a new pick is followed while it is on");
  await byTask.uncheck();
  await until(async () => (await f.call("/api/model-savings")).values.difficulty.mode === "off", "switched off");
  assert.deepEqual(f.errors, []);
});

test("D4 Add a computer: each kind that is not pairing says why; rule boxes wait for words before Add a rule and Test", async (t) => {
  const f = await fixture(t);
  await signIn(f);
  await settingsPage(f.page, "computer");
  await f.page.locator('#main [data-act="comp-add"]').click();
  for (const [kind, words] of [["sandbox", /can't make a private computer/], ["cloud", /keepoak\.com account/], ["remote", /separate safety review/]]) {
    const card = f.page.locator(`.dlg [data-act="comp-kind"][data-v="${kind}"]`);
    assert.equal(await card.getAttribute("aria-disabled"), "true", kind);
    assert.match(await card.getAttribute("data-tip"), words, kind);
  }
  assert.equal(await f.page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]').getAttribute("aria-disabled"), null, "pairing stays live");
  await f.page.keyboard.press("Escape");

  await f.page.locator('[data-act="setpage"][data-v="permissions"]').click();
  await f.page.locator('#main [data-act="rule-add8"]').click();
  const save = f.page.locator('.dlg [data-act="rule-save8"]');
  assert.equal(await save.isDisabled(), true, "Add a rule waits for words");
  await f.page.locator(".dlg #rule-new8").fill("git status");
  assert.equal(await save.isDisabled(), false);
  await f.page.locator(".dlg #rule-new8").fill("  ");
  assert.equal(await save.isDisabled(), true);
  await f.page.keyboard.press("Escape");
  await f.page.locator('#main [data-act="ruletestb17"]').click();
  const run = f.page.locator('.dlg [data-act="rulerunb17"]');
  assert.equal(await run.isDisabled(), true, "Test waits for words");
  await f.page.locator(".dlg #rule-in-b17").fill("git status");
  assert.equal(await run.isDisabled(), false);
  await run.click();
  await f.page.locator(".dlg .res-line-b17").waitFor();
  assert.deepEqual(f.errors, []);
});

test("D5 On this computer › Run sets up the model Ollama already has, as it is", async (t) => {
  const f = await fixture(t);
  const sent = [];
  let finished = false;
  await f.page.route("**/api/local-models/setup", async (route) => {
    sent.push(JSON.parse(route.request().postData()));
    await route.fulfill({ json: { id: "job-run", runtime: "ollama", stage: "checking", message: "Checking this computer…", percent: 0, request: sent.at(-1) } });
  });
  await f.page.route("**/api/local-models", async (route) => {
    const real = await (await route.fetch()).json();
    const setups = sent.length ? [{ id: "job-run", runtime: "ollama", stage: finished ? "done" : "loading", message: "Loading…", percent: 100, request: sent[0], finishedAt: finished ? "2026-09-27T10:00:00Z" : null }] : [];
    finished = sent.length > 0;
    await route.fulfill({ json: { ...real, mode: "when-needed", ollama: { installed: true, models: [{ name: "mine:latest", size: 2 ** 31 }] }, oneClick: { ...(real.oneClick ?? {}), loaded: [], setups } } });
  });
  await signIn(f);
  await settingsPage(f.page, "local");
  await f.page.locator('#main [data-act="lm-run"][data-id="mine:latest"]').click();
  await until(() => sent.length === 1, "the setup was asked for");
  assert.deepEqual(sent[0], { runtime: "ollama", name: "mine:latest", found: true });
  await until(() => finished, "the job was followed");
  assert.deepEqual(f.errors, []);
});

test("D6 an account paused with Pause has Resume on its own row, and answers again", async (t) => {
  const f = await fixture(t);
  const added = await f.call("/api/accounts/add", { pool: POOL, label: "Second", key: KEY });
  const second = added.accounts.at(-1).id;
  const disabled = async () => (await f.call("/api/accounts")).pools.find((p) => p.pool === POOL).accounts.find((a) => a.id === second).disabled;
  await signIn(f);
  await settingsPage(f.page, "accounts");
  const resume = f.page.locator(`#main [data-act="acct-resume"][data-pool="${POOL}"][data-id="${second}"]`);
  assert.equal(await resume.count(), 0, "an account that answers has no Resume");
  await f.page.locator('#main [data-act="acsel15"]').click();
  await f.page.locator(`#main [data-acc15="${POOL}/${second}"]`).check();
  await f.page.locator('#main [data-act="acbulk15"][data-v="pause"]').click();
  await until(async () => (await disabled()) === true, "paused in the engine");
  await resume.click();
  await until(async () => (await disabled()) === false, "answers again");
  await until(async () => (await resume.count()) === 0, "Resume is gone once it answers");
  assert.deepEqual(f.errors, []);
});

test("D7 account pools: Move to the next account is each list's own switch, with how the next one is picked and what switching means", async (t) => {
  const f = await fixture(t);
  await f.call("/api/accounts/add", { pool: POOL, label: "Second", key: KEY });
  const list = async () => (await f.call("/api/accounts")).pools.find((p) => p.pool === POOL);
  await signIn(f);
  await settingsPage(f.page, "accounts");
  const next = f.page.locator("#main #ac-next");
  assert.equal(await next.isChecked(), true, "on by itself with two accounts");
  await next.uncheck();
  await until(async () => (await list()).autoSwitch === false, "switched off in the engine");
  await next.check();
  await until(async () => (await list()).autoSwitch === true, "on again");
  for (const strategy of ["round-robin", "least-used", "priority"]) {
    await f.page.locator(`#main [data-act="ac-strategy"][data-v="${strategy}"]`).click();
    await until(async () => (await list()).strategy === strategy, strategy);
  }
  assert.match(await f.page.locator("#main").innerText(), /Switching doesn't merge plans: each account's own terms apply\. It also starts the provider's prompt cache again/);
  assert.deepEqual(f.errors, []);
});
