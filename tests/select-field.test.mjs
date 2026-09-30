// The remaining dropdowns use the window's glass picker, and fall back to the platform's own picker where it serves
// people better: forced colours (and touch). A disabled glass picker never opens. Headless, one window.
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("selectField draws the glass picker, and the native one under forced colours", async (t) => {
  const { page, errors } = await newWindow(t);
  const draw = () => page.evaluate(async () => {
    const { selectField } = await import("/app/core/gsel.js");
    return selectField({ id: "pick-x", label: "Pick", options: [["a", "A"], ["b", "B"]], value: "b" });
  });
  const glass = await draw();
  assert.doesNotMatch(glass, /^<select/);
  assert.match(glass, /pick-x/);
  await page.emulateMedia({ forcedColors: "active" });
  const native = await draw();
  assert.match(native, /^<select class="inp "[^>]* id="pick-x"/);
  assert.match(native, /<option value="b" selected>B<\/option>/);
  assert.deepEqual(errors, []);
});
