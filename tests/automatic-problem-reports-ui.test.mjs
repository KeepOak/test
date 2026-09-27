import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { reportItemIds } from "../dist/diagnostic-report.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor, pressUntil } from "./places.mjs";

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-auto-problem-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const adapter = { id: "problem-chat", kind: "problem-chat", botName: () => "Branch",
    async start() {}, async stop() {}, async send() { return "sent-1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  const sessionId = app.store.createSession(app.runtime.owner);
  app.channels.link(app.runtime.owner, { channel: adapter.id, chatId: "owner-room", sessionId });
  app.store.save("settings", app.runtime.owner, `channel-session:${adapter.id}:owner-room`, {
    sessionId, channel: adapter.id, chatId: "owner-room", title: "Problems",
    updatedAt: new Date().toISOString(), linked: true,
  });
  const server = await startServer(app, { dataDir, port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#problem-report-card");
  // The card sits below Updating by itself and The keeper (DG-192) and fills its form only once it is seen,
  // so it is scrolled to the way a person reaches it.
  await page.locator("#automatic-problem-mode").scrollIntoViewIfNeeded();
  return { app, page };
}

// Redesign: Coming soon (sw:ad-crash, "Send crash reports" in Settings › Advanced), checked at fc541c24; the card's preview and destination are replaced by that one switch.
test.skip("automatic problem reports show the exact preview and save only a linked owner destination", async (t) => {
  const { app, page } = await openApp(t);
  const mode = page.locator("#automatic-problem-mode");
  await mode.waitFor({ state: "visible" });
  assert.equal(await mode.inputValue(), "off", "automatic sending ships off");
  const destination = page.locator("#automatic-problem-destination");
  await page.waitForFunction(() => document.querySelectorAll("#automatic-problem-destination option").length === 2);
  assert.deepEqual(await destination.locator("option").allTextContents(), ["Choose where", "Problems — problem-chat"]);
  const itemIds = await page.locator('input[id^="automatic-problem-item-"]').evaluateAll((controls) =>
    controls.map((control) => control.id.replace("automatic-problem-item-", "")));
  assert.deepEqual(itemIds, reportItemIds,
    "every server-supported report part can be selected without editing a settings file");

  await mode.selectOption("on");
  await destination.selectOption({ label: "Problems — problem-chat" });
  await page.getByLabel("Crashes", { exact: true }).uncheck();
  for (const label of ["Activity log", "Crash notes"])
    await page.getByLabel(label, { exact: true }).uncheck();
  await page.locator("#automatic-problem-preview-kind").selectOption("update");
  await page.locator("#automatic-problem-preview-summary").fill("The update stopped for alice@example.com");
  await pressUntil(page.getByRole("button", { name: "Preview exactly what would be sent", exact: true }),
    () => page.locator("#automatic-problem-preview").filter({ hasText: "Branch Agent noticed an update problem" })
      .waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false));
  const preview = await page.locator("#automatic-problem-preview").textContent();
  assert.doesNotMatch(preview, /alice@example\.com/);
  assert.match(preview, /About this computer and Branch/);

  await pressUntil(page.getByRole("button", { name: "Save automatic reports", exact: true }),
    () => page.locator("#automatic-problem-status").filter({ hasText: "Saved" })
      .waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false));
  const saved = app.store.get("settings", app.runtime.owner, "automatic-problem-reports").data;
  assert.equal(saved.mode, "on");
  assert.deepEqual(saved.destination, { kind: "channel", channel: "problem-chat", chatId: "owner-room" });
  assert.deepEqual(saved.events, ["update"]);
  assert.deepEqual(saved.items, ["about", "updates"]);
});

// Redesign: Coming soon (sw:ad-crash and sw:lang), checked at fc541c24; the card is replaced by that one switch.
test.skip("automatic problem reports are translated and fit a 400 px window", async (t) => {
  const { page } = await openApp(t);
  await page.setViewportSize({ width: 400, height: 900 });
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.getByRole("heading", { name: "Envoyer automatiquement les futurs problèmes", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(await page.getByLabel("Espace disque et autorisations", { exact: true }).count(), 1);
  await page.locator("#automatic-problem-preview-summary").fill("x".repeat(500));
  await pressUntil(page.getByRole("button", { name: "Prévisualiser exactement ce qui serait envoyé", exact: true }),
    () => page.locator("#automatic-problem-preview").waitFor({ state: "visible", timeout: 20000 })
      .then(() => true, () => false));
  const fits = await page.locator("#problem-report-card").evaluate((card) => card.scrollWidth <= card.clientWidth);
  assert.equal(fits, true, "the card has no sideways overflow at 400 px");
});
