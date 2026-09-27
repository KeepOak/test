/**
 * Wave 8 screenshots for the web-ui third pass: the artifact card, the flow editor, the report view
 * and the to-do card, in both themes at both widths. Not a test — run it with
 * `node tests/wave8-web-ui-3-screenshots.mjs`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const OUT = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave8-web-ui-3";
/* A model that answers with a chart, so the artifact card has something real in it. */
const answers = { name: "scripted", async complete() {
  return { content: "Here is how the week went.\n\n```chart\n"
    + '{"type":"bar","title":"Cups of tea by day","data":[{"label":"Mon","value":3},'
    + '{"label":"Tue","value":7},{"label":"Wed","value":5},{"label":"Thu","value":6}]}'
    + "\n```\n\nTuesday was the busy one.", toolCalls: [] };
} };

const toTop = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  for (const node of document.querySelectorAll("*")) if (node.scrollTop) node.scrollTop = 0;
});

const root = await mkdtemp(join(tmpdir(), "branch-wave8-shots-"));
await mkdir(OUT, { recursive: true });
const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: answers });
const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
const call = (method, path, body) => fetch(server.url + path, {
  method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then((r) => r.json());

/* Something to look at on every screen: a finished task, a saved flow, and two things to do. */
await call("POST", "/api/run", { prompt: "how many cups of tea did I make this week" });
await call("POST", "/api/flows", { name: "Morning tidy-up", description: "What to do first thing",
  nodes: [
    { name: "Read the notes", kind: "prompt", prompt: "Read yesterday's notes", retries: 0, timeoutMs: 120000 },
    { name: "Check with me", kind: "approval", question: "Shall I send the summary?", retries: 0, timeoutMs: 120000 },
    { name: "Send it", kind: "prompt", prompt: "Send the summary", retries: 0, timeoutMs: 120000 },
  ] });
await call("POST", "/api/todos", { text: "Ring the plumber about the boiler" });
await call("POST", "/api/todos", { text: "Send the meter reading", dueAt: new Date(Date.now() + 86_400_000).toISOString() });

const browser = await chromium.launch({ headless: true });
const taken = [];
for (const theme of ["forest", "daylight"]) {
  for (const [width, height] of [[1280, 800], [400, 800]]) {
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
    await page.reload();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.evaluate(async (wanted) => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), appearance: wanted, followSystem: false });
    }, theme);

    const show = async (view) => {
      const nav = page.locator(`[data-view="${view}"]`).first();
      if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
      await nav.click();
      await page.evaluate(() => document.body.classList.remove("rail-open"));
      await page.waitForTimeout(600);
    };
    const shot = async (name) => {
      await toTop(page);
      const file = join(OUT, `${name}-${theme}-${width}x${height}.png`);
      await page.screenshot({ path: file, fullPage: width === 1280 });
      taken.push(file);
    };

    /* 1. The artifact card, from a reply that carries a chart. */
    await show("chat");
    await page.locator("#prompt").fill("How many cups of tea did I make this week?");
    await page.locator("#send").click();
    await page.locator(".message.assistant .artifact").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(700);
    await shot("artifact-card");

    /* 2. The to-do card in the context pane. On a narrow window the pane is a slide-over, so it is
          opened with the keyboard the same way the owner would (Ctrl+Shift+K). */
    if (width < 1024) {
      await page.keyboard.press("ControlOrMeta+Shift+K");
      await page.waitForTimeout(400);
    }
    const todos = page.locator("#context-todos");
    if (await todos.isVisible()) {
      await todos.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const file = join(OUT, `todo-card-${theme}-${width}x${height}.png`);
      await page.screenshot({ path: file, fullPage: false });
      taken.push(file);
    } else {
      console.log(`todo card not on screen at ${width}px in ${theme}`);
    }
    if (width < 1024) await page.keyboard.press("ControlOrMeta+Shift+K");

    /* 3. The flow editor, with a saved flow open in it. */
    await show("procedures");
    await page.locator("#editor-flow").selectOption({ label: "Morning tidy-up" }).catch(() => {});
    await page.waitForTimeout(800);
    await page.locator("#flow-editor").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot("flow-editor");

    /* 4. The report view, in Activity. */
    await show("runs");
    await page.locator("#report-card").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot("report-view");

    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (sideways > 1) console.log(`WARNING: ${theme} at ${width}px scrolls sideways by ${sideways}px`);
    await page.close();
  }
}
await browser.close();
await server.close();
await app.close();
await rm(root, { recursive: true, force: true });
for (const file of taken) console.log(file);
