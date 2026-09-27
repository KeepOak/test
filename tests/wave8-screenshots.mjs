/**
 * Wave 8 design QA: one picture of every screen, in both themes, at both widths.
 * Not a test. Run it twice, once before the fixes and once after:
 *
 *   node tests/wave8-screenshots.mjs before
 *   node tests/wave8-screenshots.mjs after
 *
 * Both runs write the same file names into
 * C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave8-design-qa/<stage>/
 * so the contact sheet in that folder can put them side by side.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const stage = process.argv[2] ?? "before";
const OUT = join("C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave8-design-qa", stage);

/** A provider that answers without a network, so every screen has something on it. */
const answers = {
  name: "scripted",
  async complete(request) {
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return { content: `## What I did\n\nThe answer for **${asked}**.\n\n- looked it up\n- wrote it down\n`, toolCalls: [] };
  },
};

/* Every screen the owner can reach, as [file name, rail view]. */
const SECTIONS = [
  ["conversation", "chat"],
  ["activity", "runs"],
  ["usage", "usage"],
  ["memory", "memory"],
  ["skills", "skills"],
  ["specialists", "specialists"],
  ["procedures", "procedures"],
  ["schedules", "schedules"],
  ["documents", "documents"],
  ["settings", "settings"],
];
const SIZES = [[1280, 800], [400, 800]];
const THEMES = ["forest", "daylight"];

/** The reading column scrolls on its own, so the window's own scroll is not enough. */
const toTop = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  for (const node of document.querySelectorAll("*")) if (node.scrollTop) node.scrollTop = 0;
});

const root = await mkdtemp(join(tmpdir(), "branch-wave8-shots-"));
await mkdir(OUT, { recursive: true });

/**
 * A workspace of its own for each theme and width. The welcome card shows once per workspace, so
 * sharing one would photograph first run in the first pass only; this way every variant gets it.
 */
async function freshWorkspace(tag) {
  const dataDir = join(root, tag, "data");
  const app = await createBranch({ workspace: join(root, tag, "workspace"), dataDir, provider: answers });
  const server = await startServer(app, { dataDir, port: 0 });
  const call = (method, path, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());
  /* Something to look at on Activity, Usage and Memory. */
  await call("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  const first = await call("POST", "/api/run", { prompt: "the kitchen tiles" });
  await call("POST", "/api/run", { prompt: "the car insurance" });
  await call("POST", "/api/labels", { target: "conversation", targetId: first.sessionId, label: "house" }).catch(() => {});
  await call("POST", "/api/usage/metering", { enabled: true, folder: "usage", every: "daily" }).catch(() => {});
  return { app, server };
}

const browser = await chromium.launch({ headless: true });
const wide = (width) => width >= 720;
let taken = 0;
const overflows = [];

const shot = async (page, name, width, full = false) => {
  await toTop(page);
  await page.waitForTimeout(220);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
  taken += 1;
};

const setTheme = (page, theme) => page.evaluate(async (wanted) => {
  const { applyAppearance, currentAppearance } = await import("/appearance.js");
  applyAppearance({ ...currentAppearance(), appearance: wanted, followSystem: false });
}, theme);

for (const theme of THEMES) {
  for (const [width, height] of SIZES) {
    const tag = `${theme}-${width}x${height}`;
    const { app, server } = await freshWorkspace(tag);
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(server.url);

    /* 1. The lock screen, before anything is unlocked. */
    await page.evaluate(async (wanted) => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), appearance: wanted, followSystem: false });
    }, theme).catch(() => {});
    await shot(page, `lock-${tag}`, width);

    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await setTheme(page, theme);

    /* 2. First run: the welcome card, before a model is chosen, and once one is picked. */
    await page.locator("#first-run").waitFor({ state: "visible" });
    await shot(page, `first-run-${tag}`, width);
    await page.getByRole("button", { name: /Try it without an account/ }).click();
    await page.waitForTimeout(500);
    await shot(page, `first-run-chosen-${tag}`, width);
    await page.locator("#first-run").waitFor({ state: "hidden" });

    /* A fresh load so the rail, its chips and every card are drawn from what exists. */
    await page.reload();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await setTheme(page, theme);
    await page.waitForTimeout(600);

    const show = async (view) => {
      const nav = page.locator(`.nav[data-view="${view}"]`).first();
      if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
      await nav.click();
      await page.evaluate(() => document.body.classList.remove("rail-open"));
      await page.waitForTimeout(500);
    };

    /* 3. Every section. Settings is one tall picture so all its cards are in it. */
    for (const [name, view] of SECTIONS) {
      await show(view);
      await shot(page, `${name}-${tag}`, width, view === "settings" && width === 1280);
    }

    /* 4. The pieces that only appear when something is opened. */
    await show("chat");
    await page.keyboard.press("ControlOrMeta+KeyK");
    await page.waitForTimeout(350);
    await shot(page, `palette-${tag}`, width);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    const owner = page.locator("#owner-menu-button");
    if (!(await owner.isVisible())) await page.locator("#rail-toggle").click();
    await owner.click().catch(() => {});
    await page.waitForTimeout(350);
    await shot(page, `owner-menu-${tag}`, width);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.body.classList.remove("rail-open"));
    await page.waitForTimeout(250);

    if (wide(width)) {
      const aside = page.locator("#aside-toggle");
      if (await aside.count()) {
        await aside.click().catch(() => {});
        await page.waitForTimeout(400);
        await shot(page, `context-pane-${tag}`, width);
        await aside.click().catch(() => {});
      }
    }

    /* 5. A conversation with a reply in it. */
    const box = page.locator("#prompt");
    await box.waitFor({ state: "visible" });
    await box.fill("Say hello and tell me what you can do.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    await shot(page, `conversation-answered-${tag}`, width);

    /* 6. The receipt sheet. "Look inside" hangs off a task row in Activity, not the reply. */
    await show("runs");
    const inside = page.locator(".inspect-open").first();
    await inside.waitFor({ state: "visible", timeout: 15000 });
    await inside.click();
    await page.locator("#inspect-panel").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(600);
    await shot(page, `look-inside-${tag}`, width);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) overflows.push(`${tag}: ${overflow}px too wide`);
    await page.close();
    await server.close();
    await app.close();
  }
}
await browser.close();
await rm(root, { recursive: true, force: true });
console.log(`${taken} pictures into ${OUT}`);
if (overflows.length) console.error("SIDEWAYS SCROLL:\n  " + overflows.join("\n  "));
