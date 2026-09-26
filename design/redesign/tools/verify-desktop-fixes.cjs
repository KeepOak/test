// Verifies the desktop fixes (branch claude/rw4-desktop-fixes) against a real engine, in a browser: the title bar is the window's
// moving area with its buttons still pressable, the "Read IDENTITY.md" switch on Instructions & personality is the
// engine's own switch, Export conversation adds the engine's Markdown copy to Library › Documents, and, with a scripted
// stand-in for the desktop's window.branchDesktop, the conversation and memory archives go to the desktop's guarded
// export instead of a download. The real desktop run is tests/desktop-window and tests/desktop-export (PR #352).
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-desktop-fixes.cjs
// against a FRESH engine started with BRANCH_PROVIDER=demo. Records every page error.
"use strict";

const PORT = process.env.PORT || "3471";
const TOKEN = process.env.TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;
const IDENTITY = "# Verify Juniper\n\nKeep checked results concise.\n";

async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function signIn(page) {
  await call("POST", "onboarding", { done: true });
  await call("POST", "conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}

async function titlebar(page) {
  const regions = await page.evaluate(() => {
    const read = (el) => { const s = getComputedStyle(el); return s.webkitAppRegion ?? s.getPropertyValue("-webkit-app-region"); };
    return { header: read(document.querySelector("#app header.titlebar")), button: read(document.querySelector("#app header.titlebar button")) };
  });
  check("title bar: the row is the moving area, its buttons still press", regions.header === "drag" && regions.button === "no-drag", JSON.stringify(regions));
}

async function identitySwitch(page) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('.set-nav [data-act="setpage"][data-v="instructions"]').click();
  await page.locator('[data-act="if-open"][data-f="identity"]').click();
  await page.locator("#if-text").fill(IDENTITY);
  await page.locator('[data-act="if-save"][data-f="identity"]').click();
  await page.locator(".toast").filter({ hasText: /^Saved\./ }).waitFor();
  const read = page.getByLabel("Read IDENTITY.md", { exact: true });
  check("Read IDENTITY.md: drawn off, as the engine has it", !(await read.isChecked()) && (await get("context-files")).settings.files.identity === undefined);
  await read.check();
  await sleep(800);
  const on = await get("context-files");
  check("Read IDENTITY.md on: the engine's switch is on (GET /api/context-files)", on.settings.files.identity === "on", JSON.stringify(on.settings.files));
  const kit = (await get("settings-kit/files")).files.find((f) => f.slot === "identity");
  check("Read IDENTITY.md on: the engine carries the saved file (GET /api/settings-kit/files)", kit.setting === "on" && kit.outcome === "carried", `${kit.setting} · ${kit.outcome}`);
  check("Read IDENTITY.md on: the switch is drawn from the engine", await page.getByLabel("Read IDENTITY.md", { exact: true }).isChecked());
  await page.getByLabel("Read IDENTITY.md", { exact: true }).uncheck();
  await sleep(800);
  check("Read IDENTITY.md off: the engine's switch is off", (await get("context-files")).settings.files.identity === "off");
  await page.locator(".set-nav .set-back").click();
  await page.locator("#prompt").waitFor({ state: "visible" });
}

async function conversation(page, prompt = "Verify the desktop export") {
  await page.locator("#prompt").fill(prompt);
  await page.locator("#send").click();
  for (let i = 0; i < 120; i++) {
    const run = (await get("state")).runs?.find((r) => r.prompt === prompt);
    if (run?.status === "completed") return;
    await sleep(500);
  }
  throw new Error("the task never completed");
}

async function exportToDocuments(page) {
  const before = (await get("documents")).documents?.length ?? 0;
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="export-conv"]').click();
  await page.locator(".toast").filter({ hasText: "Saved as Markdown to Library › Documents." }).waitFor({ timeout: 30000 });
  const docs = (await get("documents")).documents ?? [];
  const added = docs.find((d) => /^conversation-[a-f0-9]{8}\.md$/.test(d.name));
  check("Export conversation: the Markdown copy is in Library › Documents (GET /api/documents)", docs.length === before + 1 && added, added?.name ?? JSON.stringify(docs.map((d) => d.name)));
}

/* The desktop's preload, stood in for: records what the window hands the guarded export, and saves nothing. */
async function desktopStandIn(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__handed = [];
    window.branchDesktop = Object.freeze({
      exportConversation: async (text) => { window.__handed.push(["conversation", text]); return { saved: true }; },
      exportMemory: async (text) => { window.__handed.push(["memory", text]); return { saved: true }; },
    });
  });
  await signIn(page);
  await conversation(page, "Verify the desktop archive");
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="export-conv"]').click();
  await page.waitForFunction(() => window.__handed.some(([kind]) => kind === "conversation"), null, { timeout: 15000 });
  const conv = JSON.parse((await page.evaluate(() => window.__handed.find(([kind]) => kind === "conversation")[1])));
  check("desktop stand-in: Export conversation hands the engine's archive to window.branchDesktop.exportConversation",
    conv.format === "branch-agent-conversation" && conv.messages?.some((m) => m.content === "Verify the desktop archive") && conv.messages.at(-1).role === "assistant", conv.format);
  await call("POST", "memory/import", { jsonl: JSON.stringify({ id: "5c2e1b7a-3d4f-4a6b-9c8d-7e6f5a4b3c2d", data: { text: "Verified desktop memory" } }) });
  await page.reload();
  await page.waitForSelector("#main", { timeout: 15000 });
  await page.locator('#side [data-act="view"][data-v="library"]').click();
  await page.locator('[data-act="ptab"][data-place="library"][data-v="memory"][aria-selected="true"]').waitFor();
  await page.getByRole("button", { name: "More for memory", exact: true }).click();
  await page.locator('.pop [data-act="memexp15"][data-v="archive"]').click();
  await page.waitForFunction(() => window.__handed.some(([kind]) => kind === "memory"), null, { timeout: 15000 });
  const memory = JSON.parse(await page.evaluate(() => window.__handed.find(([kind]) => kind === "memory")[1]));
  const engine = await get("memory/export");
  check("desktop stand-in: Save a full archive hands the engine's archive to window.branchDesktop.exportMemory",
    memory.format === "branch-agent-memory" && memory.records.length === engine.records.length && memory.records.some((r) => r.data.text === "Verified desktop memory"));
  check("desktop stand-in: zero page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

async function run() {
  const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    for (const step of [titlebar, identitySwitch, conversation, exportToDocuments, () => desktopStandIn(browser)]) {
      await page.keyboard.press("Escape").catch(() => null);
      try { await step(page); } catch (error) { check(`step ${step.name || "desktopStandIn"} ran`, false, error.message.split("\n")[0]); }
    }
  } finally {
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
