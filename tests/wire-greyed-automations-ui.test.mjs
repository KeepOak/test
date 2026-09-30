/* wire-greyed: two Automations dialogs had a greyed primary because the list had no place for what it needs.
   - Days off and holidays › Add a day off: a date box now sits under the list, and the day goes into the engine's own
     calendar (POST /api/calendar daysOff), shown in the list at once.
   - Tell another app when something happens › Send a test: the address is picked in the dialog and the engine sends its
     test message to it (POST /api/webhooks/<id>/test), here to a server on the loopback address.
   Mutation: in public/app/places/automations17.js drop go: () => sendTest(), and the second case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function automations(t, tab) {
  const root = await mkdtemp(join(tmpdir(), "branch-wire-automations-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet,
    web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.keyboard.press("Escape");
  const open = async () => {
    await page.evaluate(([tab]) => {
      for (const [act, data] of [["view", { v: "automations" }], ["ptab", { place: "automations", v: tab }]]) {
        const b = document.createElement("button"); b.dataset.act = act; Object.assign(b.dataset, data);
        document.getElementById("app").append(b); b.click(); b.remove();
      }
    }, [tab]);
    await page.waitForTimeout(1200);
  };
  return { page, errors, call, open };
}

test("Add a day off takes the date from the dialog and the engine keeps it", async (t) => {
  const { page, errors, call, open } = await automations(t, "scheduled");
  await open();
  await page.locator('[data-act="demob17"][data-k="holidays"]').click();
  const add = page.locator('[data-act="demodob17"][data-k="holidays"]');
  assert.equal(await add.getAttribute("aria-disabled"), null, "Add a day off is live");
  await add.click();
  await page.locator(".toast", { hasText: "Pick the day first" }).waitFor();
  await page.locator("#d17-day").fill("2026-12-24");
  await add.click();
  await page.locator(".dlg .prow").first().waitFor();
  assert.deepEqual((await call("calendar")).settings.daysOff, ["2026-12-24"]);
  assert.deepEqual(errors, []);
});

test("Send a test goes to the address picked, and says what it answered", async (t) => {
  const heard = [];
  const hook = createServer((request, response) => { let body = ""; request.on("data", (d) => { body += d; }); request.on("end", () => { heard.push(JSON.parse(body)); response.end("ok"); }); });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => hook.close(resolve)));
  const { page, errors, call, open } = await automations(t, "triggers");
  await call("webhooks", { name: "Status board", url: `http://127.0.0.1:${hook.address().port}/in`, events: ["run.completed"] });
  await open();
  await page.locator('[data-act="demob17"][data-k="outhook"]').click();
  await page.locator("#d17-hook").waitFor();
  const send = page.locator('[data-act="demodob17"][data-k="outhook"]');
  assert.equal(await send.getAttribute("aria-disabled"), null, "Send a test is live");
  await send.click();
  await page.locator(".toast", { hasText: "The test message arrived" }).waitFor({ timeout: 20000 });
  assert.equal(heard.length, 1);
  assert.equal(heard[0].test, true);
  assert.deepEqual(errors, []);
});
