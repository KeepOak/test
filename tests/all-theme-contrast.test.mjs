/* UI-225: AA contrast in every theme and mode. Text reads at 4.5:1 or better on every ground it is drawn on, for every
   theme in the catalogue (public/theme-catalogue.js) and the owner's own, in Daylight and Moonlight, with and without More
   contrast, and with each of the eight accents the gallery offers. Checked on the colours the window actually wears
   (shell/look.js varsFromEF), and on Branch Slate's own stylesheet colours in both lights, which are worn when nothing is
   changed. The whole-page axe check (tests/window-a11y.test.mjs) covers the default look in both lights.
   Mutation: in shell/look.js varsFromEF drop readableOn for --accent-ink and the accent cases go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const PAIRS = [["--ink", "--bg"], ["--ink", "--side"], ["--ink", "--raise"], ["--ink-2", "--bg"], ["--ink-2", "--side"], ["--ink-2", "--raise"],
  ["--ink-3", "--bg"], ["--ink-3", "--side"], ["--ink-3", "--raise"], ["--on-btn", "--btn"],
  ["--accent-ink", "--bg"], ["--accent-ink", "--side"], ["--accent-ink", "--raise"], ["--accent-ink", "--accent-tint"]];

test("every theme, light and mode reads at AA", async (t) => {
  const { page, errors } = await newWindow(t);
  const { combos, fails } = await page.evaluate(async (pairs) => {
    const look = await import("/app/shell/look.js");
    const { ACCENTS } = await import("/app/shell/themes.js");
    look.L.cat = look.L.cat ?? await import("/theme-catalogue.js");
    const saved = { look: look.L.look, accent: look.L.accent };
    const fails = [];
    let combos = 0;
    for (const contrast of ["normal", "more"]) for (const accent of [null, ...ACCENTS]) {
      look.L.look = { ...(saved.look ?? {}), contrast };
      look.L.accent = accent;
      for (const [id, name] of look.looks()) for (const mode of ["light", "dark"]) {
        const v = look.varsFromEF(look.withAccent(look.lookEF(id, mode), mode), mode);
        combos++;
        for (const [fg, bg] of pairs) {
          const c = look.contrastC(v[fg], v[bg]);
          if (!(c >= 4.5)) fails.push(`${name} · ${mode} · ${contrast}${accent ? ` · accent ${accent}` : ""}: ${fg} on ${bg} is ${c.toFixed(2)}`);
        }
      }
    }
    Object.assign(look.L, saved);
    return { combos, fails };
  }, PAIRS);
  assert.ok(combos >= 2 * 9 * 2 * 20, `every theme was checked (${combos})`);
  assert.deepEqual(fails, [], `${fails.length} pairs below 4.5:1`);

  // Branch Slate as the stylesheet wears it, in both lights.
  const slate = await page.evaluate(async (pairs) => {
    const { contrastC } = await import("/app/shell/look.js");
    const html = document.documentElement, was = html.dataset.theme, out = [], grounds = new Set();
    for (const mode of ["light", "dark"]) {
      html.dataset.theme = mode;
      const css = getComputedStyle(html), v = (name) => css.getPropertyValue(name).trim();
      grounds.add(v("--bg"));
      for (const [fg, bg] of pairs) if (v(fg) && v(bg)) { const c = contrastC(v(fg), v(bg)); if (!(c >= 4.5)) out.push(`Slate · ${mode}: ${fg} ${v(fg)} on ${bg} ${v(bg)} is ${c.toFixed(2)}`); }
    }
    if (was === undefined) delete html.dataset.theme; else html.dataset.theme = was;
    if (grounds.size !== 2) out.push("the two lights did not change the page's colours");
    return out;
  }, PAIRS);
  assert.deepEqual(slate, [], "Branch Slate's own colours");
  assert.deepEqual(errors, []);
});
