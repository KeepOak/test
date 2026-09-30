/* models-ui (MODEL-051): Customize › Specialists › a specialist's card picks the model and the account its helpers answer
   with (GET/POST /api/helper-defaults, src/helper-defaults.ts). The model offers every connection; the account offers only
   the chosen connection's own accounts and starts on its usual one; both are saved in the engine at once and are still
   picked after a reload, and "Usual" clears the pick. Stand-in services only; headless, 127.0.0.1.
   Mutation: drop helperRows(id) from places/customize17.js drawSpec, and every case here goes red. */
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

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-helper-picker-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider: { name: "openai-chat", complete: quiet.complete } });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy;
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second key", key: SECOND_KEY })).accounts.find((a) => a.label === "Second key").id;
  const { id } = await app.registry.execute("specialists.propose", { name: "Reviewer", instructions: "You review.", permissions: ["files.read"],
    evaluation: { prompt: "say ready", checks: [{ path: "reviewer.txt", expected: "ready" }] } }, app.runtime.context());
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
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, call, id, second };
}

async function openCard(page, id) {
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator('.tab[data-act="ptab"][data-place="customize"][data-v="specialists"]').click();
  await page.locator(`[data-act="specb17"][data-id="${id}"]`).click();
  await page.waitForSelector('.dlg select[data-sw="spec-model"]:not([disabled])');
}
async function reload(page) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a specialist's helper model and account are picked in its card, saved in the engine and kept after a reload", async (t) => {
  const { page, errors, call, id, second } = await fixture(t);
  await openCard(page, id);
  const model = page.locator('.dlg select[data-sw="spec-model"]');
  assert.equal(await model.inputValue(), "", "nothing saved: the usual route");
  assert.equal(await page.locator('.dlg select[data-sw="spec-account"]').count(), 0, "no account list before a connection with accounts is picked");

  await model.selectOption(POOL);
  await waitFor(async () => (await call("/api/helper-defaults")).specialists[id]?.model === POOL);
  await page.waitForSelector('.dlg select[data-sw="spec-account"]:not([disabled])');
  const account = page.locator('.dlg select[data-sw="spec-account"]');
  assert.equal(await account.inputValue(), "", "starts on the connection's usual account");
  assert.deepEqual(await account.locator("option").evaluateAll((os) => os.map((o) => o.value)), ["", "primary", second], "only this connection's own accounts");
  await account.selectOption(second);
  await waitFor(async () => (await call("/api/helper-defaults")).specialists[id]?.accountRef?.account === second);
  assert.deepEqual((await call("/api/helper-defaults")).specialists[id], { model: POOL, accountRef: { pool: POOL, account: second } });

  await reload(page);
  await openCard(page, id);
  assert.equal(await page.locator('.dlg select[data-sw="spec-model"]').inputValue(), POOL);
  assert.equal(await page.locator('.dlg select[data-sw="spec-account"]').inputValue(), second);

  await page.locator('.dlg select[data-sw="spec-model"]').selectOption("");
  await waitFor(async () => (await call("/api/helper-defaults")).specialists[id] === undefined);
  await page.waitForFunction(() => !document.querySelector('.dlg select[data-sw="spec-account"]'));
  assert.deepEqual(errors, []);
});
