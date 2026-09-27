/**
 * Wave 7 screenshots: both themes, both widths, of the screens this wave changed. Not a test —
 * run it with `node tests/wave7-screenshots.mjs` to refresh the pictures in the report.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const OUT = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave7-polish";
const answers = { name: "scripted", async complete(request) {
  const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return { content: `## What I did\n\nThe answer for **${asked}**.\n\n- looked it up\n- wrote it down\n`, toolCalls: [] };
} };

/** The reading column has its own scroll, so the window's own scroll is not enough. */
const toTop = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  for (const node of document.querySelectorAll("*")) if (node.scrollTop) node.scrollTop = 0;
});

const root = await mkdtemp(join(tmpdir(), "branch-wave7-shots-"));
await mkdir(OUT, { recursive: true });
const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: answers });
const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
const call = (method, path, body) => fetch(server.url + path, {
  method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then((r) => r.json());

/* Something to look at: two tasks, a price on file, and a label. */
await call("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
const first = await call("POST", "/api/run", { prompt: "the kitchen tiles" });
await call("POST", "/api/run", { prompt: "the car insurance" });
await call("POST", "/api/labels", { target: "conversation", targetId: first.sessionId, label: "house" });
await call("POST", "/api/usage/metering", { enabled: true, folder: "usage", every: "daily" });

const browser = await chromium.launch({ headless: true });
const sizes = [[1280, 800], [400, 800]];
const screens = [["activity", "runs"], ["usage", "usage"], ["conversation", "chat"]];
for (const theme of ["forest", "daylight"]) {
  for (const [width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    if (await page.locator("#first-run").isVisible()) {
      /* "Try it without an account" finishes first run in one click. */
      await page.getByRole("button", { name: /Try it without an account/ }).click();
      await page.locator("#first-run").waitFor({ state: "hidden" });
    }
    /* A fresh load so the rail, its chips and the month card are all drawn from what exists. */
    await page.reload();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.evaluate(async (wanted) => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), appearance: wanted, followSystem: false });
    }, theme);
    /* Narrow windows keep the rail as a slide-over, so it is opened before a section is chosen. */
    const show = async (view) => {
      const nav = page.locator(`[data-view="${view}"]`).first();
      if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
      await nav.click();
      await page.evaluate(() => document.body.classList.remove("rail-open"));
    };
    for (const [name, view] of screens) {
      await show(view);
      await page.waitForTimeout(700);
      await toTop(page);
      const file = join(OUT, `${name}-${theme}-${width}x${height}.png`);
      await page.screenshot({ path: file, fullPage: width === 1280 });
      console.log(file);
    }
    /* The comparison panel, which only appears once two tasks are picked. */
    await show("runs");
    const picks = page.locator(".compare-pick");
    await picks.nth(1).waitFor({ timeout: 10000 }).catch(() => {});
    if (await picks.count() >= 2) {
      await picks.nth(0).click();
      await picks.nth(1).click();
      await page.locator("#compare-panel .compare-table").waitFor({ timeout: 10000 }).catch(() => {});
      await toTop(page);
      const file = join(OUT, `compare-${theme}-${width}x${height}.png`);
      await page.screenshot({ path: file, fullPage: width === 1280 });
      console.log(file);
    }
    /* Anything wider than the window would mean sideways scrolling; there must be none. */
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) console.error(`SIDEWAYS SCROLL at ${width}px: ${overflow}px too wide`);
    await page.close();
  }
}
await browser.close();
await server.close();
await app.close();
await rm(root, { recursive: true, force: true });
