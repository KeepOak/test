/* Settings › Chat apps › Steps in chats, in a headless browser against a throwaway engine it starts itself (its own
   temporary data folder, a free port, two stand-in chat apps that send nothing anywhere):
     node design/redesign/tools/verify-chat-steps.mjs [screenshot.png]
   Every knob is drawn from the engine and each change is confirmed through GET /api/channels (`steps`); each connected
   app's row says what it will show, and an app's own choice wins over every app's. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../../../dist/index.js";
import { startServer } from "../../../dist/server.js";

const shot = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "branch-verify-steps-"));
const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
const server = await startServer(app, { dataDir: join(root, "d"), port: 0, anyPortIfTaken: true });
const stand = (id, kind, edit) => ({ id, kind, botName: () => "Branch", async start() {}, async stop() {}, async send() { return "1"; },
  ...(edit ? { async edit() {}, async deleteMessage() {} } : {}) });
await app.channels.attach(stand("telegram", "telegram", true), { activation: "always", pairing: true, allowlist: [] });
await app.channels.attach(stand("whatsapp", "whatsapp", false), { activation: "always", pairing: true, allowlist: [] });
const BASE = server.url.replace(/\/$/, ""), TOKEN = server.token;

const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const steps = async () => (await (await fetch(`${BASE}/api/channels`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).steps;
const until = async (read) => { for (let i = 0; i < 100; i++) { if (await read().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await fetch(`${BASE}/api/onboarding`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await page.goto(BASE);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  await page.locator('[data-act="setpage"][data-v="chatapps"]').click();
  const detail = page.locator('#main [data-act="cs-detail"][data-v="all"]');
  await detail.waitFor({ timeout: 15000 });
  check("Every step is pressed as shipped", (await detail.getAttribute("aria-pressed")) === "true");
  await page.locator('#main [data-act="cs-detail"][data-v="new"]').click();
  check("Changes only → all.detail new", await until(async () => (await steps()).settings.all.detail === "new"));
  await page.locator('#main [data-act="cs-grouping"][data-v="each"]').click();
  check("A message per step → all.grouping each", await until(async () => (await steps()).settings.all.grouping === "each"));
  await page.locator('#main [data-act="cs-overflow"][data-v="trim"]').click();
  check("Keep the newest → all.overflow trim", await until(async () => (await steps()).settings.all.overflow === "trim"));
  await page.locator('#main [data-act="cs-noedit"][data-v="off"]').click();
  check("Apps that cannot edit: Off → all.noEdit off", await until(async () => (await steps()).settings.all.noEdit === "off"));
  await page.locator("#main #f15-show-commands-as-code").setChecked(false);
  check("Show commands as code off → all.commands hide", await until(async () => (await steps()).settings.all.commands === "hide"));
  await page.locator("#main #f15-remove-the-steps-after-a-good-answer").setChecked(true);
  check("Remove the steps → all.cleanup true", await until(async () => (await steps()).settings.all.cleanup === true));
  await page.locator("#main #f15-step-counts-in-groups").setChecked(false);
  check("Step counts in groups off → all.groups off", await until(async () => (await steps()).settings.all.groups === "off"));
  const line = page.locator("#main #cs-line");
  await line.fill("80");
  await line.press("Tab");
  check("Longest line 80 → all.lineChars 80", await until(async () => (await steps()).settings.all.lineChars === 80));
  await page.locator('#main [data-act="cs-app"][data-v="telegram:verbose"]').click();
  check("Telegram: Everything → apps.telegram.detail verbose", await until(async () => (await steps()).settings.apps.telegram?.detail === "verbose"));
  const view = await steps();
  check("WhatsApp's line says it shows nothing now", view.apps.find((a) => a.id === "whatsapp").shows === "Off");
  check("Telegram's line says a message a step", view.apps.find((a) => a.id === "telegram").shows === "A message per step");
  await page.locator('#main [data-act="cs-app"][data-v="telegram:"]').click();
  check("Telegram: Same as all → its own choice goes", await until(async () => !(await steps()).settings.apps.telegram));
  if (shot) await page.locator("#main").screenshot({ path: shot });
} catch (error) { check("the run finished", false, error.message); }
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
await app.close();
server.close?.();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
