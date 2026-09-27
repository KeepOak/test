/* DG-106: the studio's "Follow my theme" is the approved sample's switch row (design/Branch-Grown-Up.html, the studio's
   `label.ctl` holding `input.sw`): "Follow my theme" at 14px/520 with the 40×24 switch beside it, and "Takes the
   highlight colour of whichever theme is on." beneath at 12.5px in the quiet text colour. The switch still does
   what the tick box did: on, no fixed colour is chosen; a colour chosen turns it off. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function studio(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-studio-follow-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  /* Trunks ship off; the studio shows its colours once they are on, as the Trunks switch in Settings does it. */
  await fetch(new URL("/api/trunks/switch", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ part: "trunks", mode: "on" }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  /* The strip reads the Trunks switch when it loads; it is read again here, as it is after the switch is pressed. */
  await page.evaluate(async () => { await (await import("/strip.js")).refresh(); (await import("/studio.js")).openAdd("trunk"); });
  await page.locator("#studio-follow").waitFor();
  return { page, errors };
}

const row = (page) => page.evaluate(() => {
  const box = document.getElementById("studio-follow"), label = box.closest("label");
  const words = label.querySelector(".studio-follow-words"), note = label.querySelector(".studio-follow-note");
  const quiet = (() => { const probe = document.createElement("i"); probe.style.color = "var(--text-3)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })();
  const w = words.getBoundingClientRect(), s = box.getBoundingClientRect(), n = note.getBoundingClientRect();
  const type = (node) => { const c = getComputedStyle(node); return `${c.fontSize}/${c.lineHeight} ${c.fontWeight}`; };
  return {
    words: words.textContent, note: note.textContent, role: box.getAttribute("role"), size: `${s.width}×${s.height}`,
    wordsType: type(words), noteType: type(note), noteQuiet: getComputedStyle(note).color === quiet,
    switchBeside: s.left > w.right && Math.abs((s.top + s.bottom) / 2 - (w.top + w.bottom) / 2) < 3,
    noteBeneath: n.top >= Math.max(w.bottom, s.bottom) - 0.5 && Math.abs(n.left - w.left) < 1,
    stacked: s.top >= w.bottom - 0.5 && Math.abs(s.left - w.left) < 1,
    checked: box.checked, pressedSwatches: document.querySelectorAll('#studio .studio-swatch[aria-pressed="true"]').length,
  };
});

// Redesign: replaced by the new window (no "Follow my theme" row), and its French is Coming soon (sw:lang), checked at
// e5b8a610.
test.skip("DG-106 in French the row's words are French", async (t) => {
  const { page, errors } = await studio(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const words = await page.evaluate(async () => { const { t } = await import("/i18n.js"); return { words: t("studio.follow"), note: t("studio.follow.note") }; });
  await page.waitForFunction((text) => document.querySelector(".studio-follow-words")?.textContent === text, words.words);
  const seen = await row(page);
  assert.deepEqual({ words: seen.words, note: seen.note }, words);
  assert.notEqual(words.note, "Takes the highlight colour of whichever theme is on.");
  assert.deepEqual(errors, []);
});

/* Codex's review of ceb75959: the sample's control row is one column at 760px and narrower (its `.ctl` phone rule):
   the words, then the switch under them, then the note. At 761px it is two columns again. */
// Redesign: replaced by the new window (no "Follow my theme" row in prototype.html's studio).
for (const [width, stacked] of [[760, true], [400, true], [761, false]]) {
  test.skip(`DG-106 at ${width} px the row is ${stacked ? "one column: words, switch, note" : "words and switch side by side"}`, async (t) => {
    const { page, errors } = await studio(t, width);
    const seen = await row(page);
    assert.deepEqual({ stacked: seen.stacked, beside: seen.switchBeside, beneath: seen.noteBeneath },
      { stacked, beside: !stacked, beneath: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "nothing scrolls sideways");
    assert.deepEqual(errors, []);
  });
}

