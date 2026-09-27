/* DG-171: Appearance's choice rows (Day or night, Season) are the approved sample's `.ctl` rows holding its `.seg`
   control (design/Branch-Grown-Up.html), measured on the rendered sample in Moonlight and Daylight: a grid of the
   label and the control with a 3px/20px gap, 12px above and below, a 1px line on top; the label 14px at 520; the
   control a 2px well of the text at 12%, 10px corners, no edge; each choice 12.5px, 5px 11px, 8px corners, in the
   text's own colour a little faded; the chosen one on the surface at 600 with a 1px shadow. Nothing changes under
   the pointer. On a phone the label sits above its control. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function appearance(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-choice-rows-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "appearance");
  await page.locator("#lx-mode .segmented-option").first().waitFor();
  return { page, errors };
}
const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).join(",");
const alpha = (color) => Number(color.match(/[\d.]+/g)[3] ?? 1);
const look = (page, host) => page.evaluate((id) => {
  const style = (node) => getComputedStyle(node);
  const row = document.getElementById(id).closest(".lx-look-row"), label = row.querySelector(".lx-look-label");
  const seg = row.querySelector(".seg"), pressed = seg.querySelector('[aria-pressed="true"]'), plain = seg.querySelector('[aria-pressed="false"]');
  return {
    row: [style(row).display, style(row).rowGap, style(row).columnGap, style(row).paddingTop, style(row).paddingBottom, style(row).borderTopWidth],
    label: [style(label).fontSize, style(label).fontWeight, style(label).color],
    seg: [style(seg).padding, style(seg).borderRadius, style(seg).borderTopWidth, style(seg).backgroundColor],
    plain: [style(plain).fontSize, style(plain).fontWeight, style(plain).padding, style(plain).borderRadius, style(plain).backgroundColor, style(plain).boxShadow, style(plain).color],
    pressed: [style(pressed).fontWeight, style(pressed).backgroundColor, style(pressed).boxShadow, style(pressed).color],
    surface: (() => { const probe = document.createElement("i"); probe.style.background = "var(--surface)"; document.body.append(probe); const color = style(probe).backgroundColor; probe.remove(); return color; })(),
    labelAbove: label.getBoundingClientRect().bottom <= seg.getBoundingClientRect().top,
  };
}, host);

for (const mode of ["Moonlight", "Daylight"]) {
  test.skip(`DG-171 ${mode}: Day or night and Season are the sample's control rows at 1440`, async (t) => {
    // Redesign: replaced by the new window (the measurements are the old approved sample's, design/Branch-Grown-Up.html;
    // Settings › Appearance now draws prototype.html's .ctl/.seg rows, checked against the prototype by design/redesign/tools/oneone.cjs).
    const { page, errors } = await appearance(t, 1440);
    await page.locator("#lx-mode").getByRole("button", { name: mode, exact: true }).click();
    await page.mouse.move(0, 0);
    for (const host of ["lx-mode", "lx-season"]) {
      const got = await look(page, host);
      assert.deepEqual(got.row, ["grid", "3px", "20px", "12px", "12px", "1px"], `${host}: the sample's .ctl row`);
      assert.deepEqual(got.label.slice(0, 2), ["14px", "520"]);
      assert.deepEqual(got.seg.slice(0, 3), ["2px", "10px", "0px"], `${host}: a well with no edge`);
      assert.equal(rgb(got.seg[3]), rgb(got.label[2]), "the well is the text's colour…");
      assert.equal(alpha(got.seg[3]), 0.12, "…at 12%");
      assert.deepEqual(got.plain.slice(0, 6), ["12.5px", "400", "5px 11px", "8px", "rgba(0, 0, 0, 0)", "none"], `${host}: a plain choice`);
      assert.equal(rgb(got.plain[6]), rgb(got.label[2]));
      assert.ok(alpha(got.plain[6]) > 0.8 && alpha(got.plain[6]) < 0.9, "a plain choice is the text a little faded");
      assert.deepEqual(got.pressed, ["600", got.surface, "rgba(0, 0, 0, 0.14) 0px 1px 2px 0px", got.label[2]], `${host}: the chosen one is raised on the surface`);
    }
    /* Under the pointer nothing changes, as in the sample. */
    const before = await look(page, "lx-mode");
    await page.locator('#lx-mode .segmented-option[aria-pressed="false"]').first().hover();
    const plainHover = await page.evaluate(() => { const node = document.querySelector('#lx-mode .segmented-option[aria-pressed="false"]:hover'); return [getComputedStyle(node).backgroundColor, getComputedStyle(node).boxShadow]; });
    assert.deepEqual(plainHover, ["rgba(0, 0, 0, 0)", "none"]);
    await page.locator('#lx-mode .segmented-option[aria-pressed="true"]').hover();
    assert.deepEqual((await look(page, "lx-mode")).pressed, before.pressed, "the chosen one keeps its look under the pointer");
    assert.deepEqual(errors, []);
  });
}

