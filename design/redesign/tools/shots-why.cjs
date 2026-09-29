/* Screenshots of three Settings pages at 1440 and 390 px wide, to see where a greyed control's reason sits (under its
   row, core/why.js) and that nothing overlaps. Also measures it: on each page, no row with a reason is wider than its
   box, the page never scrolls sideways, and no two of a row's direct parts overlap. Run against a throwaway engine only:
     PORT=<port> TOKEN=<hex> OUT=<folder> node design/redesign/tools/shots-why.cjs */
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, OUT = process.env.OUT;
if (!PORT || !TOKEN || !OUT) { console.error("Set PORT, TOKEN and OUT."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const PAGES = ["advanced", "voice", "computer"];

const measure = (page) => page.evaluate(() => {
  const bad = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const row of document.querySelectorAll("[data-why-text]")) {
    if (!row.offsetParent) continue;
    const name = (row.querySelector("b")?.textContent ?? "").trim().slice(0, 40);
    if (row.scrollWidth > row.clientWidth + 1) bad.push(`${name}: row wider than its box`);
    const parts = [...row.children].filter((c) => c.offsetParent).map((c) => c.getBoundingClientRect());
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`${name}: parts ${i} and ${j} overlap`);
    }
    const after = getComputedStyle(row, "::after");
    if (after.content === "none" || after.display === "none") bad.push(`${name}: reason not drawn`);
  }
  return { rows: document.querySelectorAll("[data-why-text]").length, bad };
});

(async () => {
  const browser = await chromium.launch({ headless: true });
  let problems = 0;
  for (const width of [1440, 390]) {
    const page = await (await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 } })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await page.waitForTimeout(1200);
    await page.keyboard.press("Control+,");
    await page.locator(".settings").waitFor();
    await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
    for (const id of PAGES) {
      const link = page.locator(`[data-act="setpage"][data-v="${id}"]`).first();
      if (!(await link.isVisible())) await page.evaluate((v) => { const b = document.createElement("button"); b.dataset.act = "setpage"; b.dataset.v = v; document.body.append(b); b.click(); b.remove(); }, id);
      else await link.click();
      await page.waitForTimeout(1300);
      const m = await measure(page);
      problems += m.bad.length;
      await page.screenshot({ path: `${OUT}/${id}-${width}.png`, fullPage: true });
      console.log(`${id} @${width}: ${m.rows} rows with a reason; ${m.bad.length ? m.bad.join("; ") : "no overlap, no sideways scroll"}`);
    }
    if (errors.length) { problems += errors.length; console.log(`page errors @${width}: ${errors.join(" | ")}`); }
    await page.close();
  }
  await browser.close();
  if (problems) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
