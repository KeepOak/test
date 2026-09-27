/**
 * Wave 8 design QA: a reading of what is actually on the screen, so the fixes are aimed at
 * measured faults rather than guesses. Not a test — `node tests/wave8-audit.mjs`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const SECTIONS = ["chat", "runs", "usage", "memory", "skills", "specialists", "procedures", "schedules", "documents", "settings"];
const answers = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

const root = await mkdtemp(join(tmpdir(), "branch-wave8-audit-"));
const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: answers });
const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
await page.goto(server.url);
await page.getByLabel("Session token", { exact: true }).fill(server.token);
await page.getByRole("button", { name: "Connect", exact: true }).click();
await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
if (await page.locator("#first-run").isVisible()) {
  /* "Try it without an account" finishes first run in one click. */
  await page.getByRole("button", { name: /Try it without an account/ }).click();
}
await page.reload();
await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
await page.waitForTimeout(800);

const report = {};
for (const view of SECTIONS) {
  /* Opened the way a person opens it in the redesigned window (tests/places.mjs). */
  await openPlace(page, view);
  await page.evaluate(() => document.body.classList.remove("rail-open"));
  await page.waitForTimeout(450);
  report[view] = await page.evaluate((id) => {
    const root = document.getElementById(id);
    const seen = [...root.querySelectorAll("*")].filter((n) => n.offsetParent !== null || n === root);
    const mono = [];
    const wide = [];
    const nameless = [];
    const scrolls = (n) => {
      for (let p = n; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") return true;
      }
      return false;
    };
    for (const n of seen) {
      const cs = getComputedStyle(n);
      /* Long prose set in the label face is the wave-8 readability fault. */
      const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(" ").trim();
      if (cs.fontFamily.includes("Mono") && own.split(/\s+/).length > 6) {
        mono.push({ tag: n.tagName.toLowerCase(), cls: n.className?.toString().slice(0, 40), text: own.slice(0, 70) });
      }
      const r = n.getBoundingClientRect();
      if (r.width > window.innerWidth + 1 && !scrolls(n)) {
        wide.push({ tag: n.tagName.toLowerCase(), cls: n.className?.toString().slice(0, 40), w: Math.round(r.width) });
      }
      if ((n.tagName === "BUTTON" || n.tagName === "INPUT" || n.tagName === "SELECT" || n.tagName === "TEXTAREA")) {
        const label = n.labels?.[0]?.textContent?.trim() || n.getAttribute("aria-label") ||
          (n.getAttribute("aria-labelledby") && document.getElementById(n.getAttribute("aria-labelledby"))?.textContent?.trim()) ||
          n.title || n.textContent.trim();
        if (!label) nameless.push({ tag: n.tagName.toLowerCase(), id: n.id, cls: n.className?.toString().slice(0, 40) });
      }
    }
    /* A checkbox stretched to the column width is the root of the "floating tick" look. */
    const stretched = [...root.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 40)
      .map((n) => ({ id: n.id, w: Math.round(n.getBoundingClientRect().width) }));
    const cards = [...root.querySelectorAll(".card")].filter((n) => n.offsetParent !== null);
    const titleless = cards.filter((c) => !c.querySelector("h2, summary")).map((c) => c.id || c.className.slice(0, 40));
    return {
      intro: !!root.querySelector(".section-intro"),
      cards: cards.length, titleless,
      monoProse: mono.length, monoSample: mono.slice(0, 4),
      overWide: wide, stretched: stretched.length, stretchedSample: stretched.slice(0, 3),
      nameless,
    };
  }, view);
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
await server.close();
await app.close();
await rm(root, { recursive: true, force: true });
