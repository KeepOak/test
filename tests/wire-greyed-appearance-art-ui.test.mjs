/* wire-greyed: Settings › Appearance had five greyed choices, now drawn as the prototype draws them (shell/procbg.js):
   Behind the glass › The grove, The oak in 3D and Growth rings (canvases in the theme's colours; the grove's season adds
   Summer), Scenery behind the list (a small pixel oak at the list's foot, on unless switched off) and the pet By the
   message box (the chat's dock hook). Each is checked on real pixels, not on a class name.
   Mutations: in shell/procbg.js drawDrawn draw nothing, and the backgrounds are blank: red. In shell/scene.js make
   sceneryHTML return "", and the scenery is missing: red. In shell/shell.js drop the addDockItem line, and no pet sits by
   the message box: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

const inked = (canvas) => canvas.evaluate((cv) => {
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
const snap = (canvas) => canvas.evaluate((cv) => cv.toDataURL());
const pick = async (page, v) => {
  await page.locator(`.set-col [data-act="bgset"][data-v="${v}"]`).click();
  await page.locator(`.set-col [data-act="bgset"][data-v="${v}"][aria-pressed="true"]`).waitFor();
};

test("the grove, the oak in 3D and the growth rings are drawn behind the glass, and the oak turns unless kept still", { timeout: 180000 }, async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "wire-art" });
  await openSettingsPage(page, "appearance");
  for (const v of ["grove", "oak3d", "rings"]) assert.equal(await page.locator(`.set-col [data-act="bgset"][data-v="${v}"]`).getAttribute("aria-disabled"), null, `${v} is live`);

  await pick(page, "grove");
  assert.equal((await call("/api/delight")).settings.background.on, true, "the engine's background switch is on");
  assert.equal(await page.locator("#bgLayer canvas.pix").count(), 2, "the grove and the air it drifts in");
  assert.ok((await inked(page.locator("#bgLayer canvas.pix").first())) > 1000, "the grove is painted");
  await page.locator('.set-col [data-act="season"][data-v="summer"]').click();
  await page.locator('.set-col [data-act="season"][data-v="summer"][aria-pressed="true"]').waitFor();

  await pick(page, "rings");
  const rings = page.locator("#bgLayer canvas");
  assert.deepEqual(await rings.evaluate((cv) => [cv.width, cv.height]), [480, 300]);
  assert.ok((await inked(rings)) > 100000, "the rings are painted");

  await pick(page, "oak3d");
  const oak = page.locator("#bgLayer canvas.pix");
  assert.ok((await inked(oak)) > 500, "the oak is drawn");
  const still = await snap(oak);
  await page.waitForTimeout(400);
  assert.equal(await snap(oak), still, "kept still (reduced motion), the oak does not turn");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await pick(page, "rings");
  await pick(page, "oak3d");
  const first = await snap(page.locator("#bgLayer canvas.pix"));
  await page.waitForTimeout(400);
  assert.notEqual(await snap(page.locator("#bgLayer canvas.pix")), first, "the oak turns");

  await page.reload();
  await page.locator("#bgLayer canvas.pix").waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("branch-scene")).bg), "oak3d", "the choice is kept");
  assert.deepEqual(errors, []);
});

test("scenery sits at the list's foot until switched off, and the pet can sit by the message box", { timeout: 180000 }, async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "wire-art-side" });
  const scenery = page.locator("#side > canvas.scenery");
  await scenery.waitFor();
  assert.ok((await inked(scenery)) > 500, "the pixel oak is painted");

  await openSettingsPage(page, "appearance");
  const box = page.locator("#a-scenery");
  assert.equal(await box.isChecked(), true, "it ships on");
  assert.equal(await box.getAttribute("aria-disabled"), null, "it is live");
  await box.click();
  await page.locator("#side > canvas.scenery").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("branch-scene")).scenery), false, "switched off, it stays off");

  await call("/api/delight/settings", { pets: { on: true, kind: "squirrel" } });
  await page.reload();
  await page.locator("#app #side").waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#side > canvas.scenery").count(), 0, "still off after a reload");
  await openSettingsPage(page, "appearance");
  const dock = page.locator('.set-col [data-act="petwhere15"][data-v="dock"]');
  assert.equal(await dock.getAttribute("aria-disabled"), null, "By the message box is live");
  await dock.click();
  await page.locator('.set-col [data-act="petwhere15"][data-v="dock"][aria-pressed="true"]').waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const b = document.createElement("button"); b.dataset.act = "newconv"; document.getElementById("app").append(b); b.click(); b.remove(); });
  await page.locator("#main .dock > .petbox").waitFor();
  assert.equal(await page.locator("#side .petbox").count(), 0, "it has left the list");
  assert.equal(await page.evaluate(() => document.body.classList.contains("pet-dock15")), true);
  assert.equal(await page.locator("#main .dock > .petbox").isVisible(), true, "it is seen by the message box");
  assert.deepEqual(errors, []);
});
