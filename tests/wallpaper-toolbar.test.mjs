import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
function contrastOfControl(el) {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  canvas.width = canvas.height = 1;
  const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const lum = rgb => rgb.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
  const style = getComputedStyle(el), ink = lum(rgba(style.color)), bg = rgba(style.backgroundColor), alpha = bg[3] / 255;
  return Math.min(...[0, 255].map(base => {
    const fill = lum(bg.map(x => x * alpha + base * (1 - alpha)));
    return (Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05);
  }));
}
test("wallpaper reaches the clear toolbar without covering controls or leaving a content gap", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "wallpaper-toolbar" });
  await page.locator("#bgLayer").waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
    for (const width of [1440, 1024, 760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => document.querySelector(".titlebar").classList.contains("merged14") === (innerWidth > 760));
      const styles = await page.evaluate(() => {
        const header = document.querySelector(".titlebar"), main = document.querySelector("#main"), layer = document.querySelector("#bgLayer");
        const h = header.getBoundingClientRect(), m = main.getBoundingClientRect(), b = layer.getBoundingClientRect();
        const s = getComputedStyle(header), control = header.querySelector('[data-act="chatmenu"]');
        const c = control.getBoundingClientRect(), at = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
        return { fill: s.backgroundColor, border: s.borderBottomWidth, shadow: s.boxShadow, blur: s.backdropFilter,
          layerTop: b.top, headerTop: h.top, mainTop: m.top, headerBottom: h.bottom,
          mainFill: getComputedStyle(main).backgroundImage, merged: header.classList.contains("merged14"),
          controlHit: control === at || control.contains(at), controlFill: getComputedStyle(control).backgroundColor,
          drag: s.webkitAppRegion, controlDrag: getComputedStyle(control).webkitAppRegion,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(styles.fill, "rgba(0, 0, 0, 0)", `${theme}/${width}: toolbar fill`);
      assert.equal(styles.border, "0px");
      assert.equal(styles.shadow, "none");
      assert.equal(styles.blur, "none");
      assert.ok(styles.layerTop <= styles.headerTop, "wallpaper starts above the toolbar");
      assert.equal(styles.controlHit, true, "the real control remains reachable");
      assert.notEqual(styles.controlFill, "rgba(0, 0, 0, 0)", "localized glass keeps the icon readable");
      assert.ok(await page.locator('.titlebar [data-act="chatmenu"]').evaluate(contrastOfControl) >= 3, `${theme}/${width}: icon contrast over black or white wallpaper`);
      const guide = page.locator('.titlebar .tb-btn', { hasText: "Guide" }), textContrast = await guide.evaluate(contrastOfControl);
      assert.ok(textContrast >= 4.5, `${theme}/${width}: toolbar text contrast ${textContrast}; ${await guide.evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor].join(" / "))}`);
      await guide.focus();
      assert.ok(await guide.evaluate(contrastOfControl) >= 4.5, "focused toolbar text retains contrast");
      await guide.evaluate(el => el.blur());
      assert.equal(styles.drag, "drag");
      assert.equal(styles.controlDrag, "no-drag");
      assert.equal(styles.overflow, false);
      if (styles.merged) { assert.equal(styles.mainTop, styles.headerTop); assert.match(styles.mainFill, /linear-gradient/); }
      else assert.ok(Math.abs(styles.mainTop - styles.headerBottom) < 1, "content begins immediately after the toolbar");
      await page.evaluate(() => document.querySelector("#app").classList.add("peek"));
      assert.equal(await page.locator(".titlebar").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
      await page.evaluate(() => document.querySelector("#app").classList.remove("peek"));
    }
  }
  assert.deepEqual(errors, []);
});
