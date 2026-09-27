/* DG-130: the rail's corner at the approved tile's size and spacing — a 58px acorn 18px in from the
   rail's edge with 12px above it and 8px below, and the pet 10px beside it at 60×54 — the same with
   Show everything on or off, dark or light, at 1440, 860 and 400 px, and in French. The pet's saved
   name is its tooltip and its name, never a caption squeezed into the corner. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { closeSettings, openSettingFor } from "./places.mjs"; // the old window's helpers, for the skipped bodies only
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const NAME = "Bartholomew Acornsby";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-corner-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/delight/settings", { pets: { on: true, name: NAME } });
  return { server, browser };
}
/* Redesign: the new window has no rail corner tile with a 58px acorn (prototype.html draws the pet walking at the foot
   of the list, shell/scene.js petHTML, and its pixel oak "Scenery behind the list" is Coming soon). What the corner
   promised about the pet is still checked: its saved name is its name, whole, never a caption squeezed into the
   list, and the list's foot fits at every width in both lights. */
async function open(f, { width, scheme }) {
  const page = await f.browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator("#side #pet-cv").waitFor();
  return { page, errors };
}
const foot = (page) => page.evaluate(() => {
  const side = document.getElementById("side").getBoundingClientRect(), pet = document.getElementById("pet-cv").getBoundingClientRect();
  const keeper = document.querySelector("#side .keeper");
  const words = [...keeper.querySelectorAll("*")].filter((node) => !node.closest("[hidden]") && node.children.length === 0 && node.textContent.trim()).map((node) => node.textContent.trim());
  return { petInside: pet.left >= side.left && pet.right <= side.right + 0.5 && pet.width > 0, words,
    sideways: document.documentElement.scrollWidth > innerWidth };
});

test("the pet at the foot of the list keeps its saved name whole, at every width, in both lights", { timeout: 360000 }, async (t) => {
  const f = await fixture(t);
  for (const width of [1440, 860, 400]) for (const scheme of ["dark", "light"]) {
    const { page, errors } = await open(f, { width, scheme });
    const m = await foot(page), at = `${width}px ${scheme}`;
    assert.equal(m.petInside, true, `${at}: the pet is inside the list`);
    assert.deepEqual(m.words, [], `${at}: no caption at the foot of the list`);
    assert.equal(m.sideways, false, `${at}: nothing scrolls sideways`);
    assert.equal(await page.locator("#pet-cv").getAttribute("aria-label"), `${NAME} the squirrel. Click for a tip.`, `${at}: the saved name, whole`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

/* The old window's corner measures, for the skipped bodies below. */
/** Every box the corner is measured by, relative to the rail's inner edge. */
const measure = (page) => page.evaluate(() => {
  const box = (selector) => document.querySelector(selector).getBoundingClientRect();
  const rail = box("#conversation-rail"), corner = box("#delight-corner"), acorn = box("#keepoak-acorn");
  const lane = box("#pet-lane"), pet = box("#pet"), foot = box(".rail-foot"), inner = corner.left;
  return {
    acorn: [acorn.width, acorn.height], backing: document.getElementById("keepoak-acorn").width,
    inset: acorn.left - inner, above: acorn.top - corner.top, below: corner.bottom - acorn.bottom,
    beside: lane.left - acorn.right, pet: [pet.width, pet.height], petBottom: pet.bottom - acorn.bottom,
    petInside: pet.left >= rail.left && pet.right <= rail.right + 0.5, onFoot: foot.top - corner.bottom,
    words: document.getElementById("delight-corner").innerText.trim(), sideways: document.documentElement.scrollWidth > innerWidth,
  };
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610; and the corner tile is replaced (see above).
test.skip("in French the corner keeps its size and the pet keeps its saved name", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 400, scheme: "dark", everything: false });
  await openSettingFor(page, "#appearance-language");
  await page.locator("#appearance-language").selectOption("fr");
  await closeSettings(page);
  await page.waitForFunction((name) => document.getElementById("pet")?.title.startsWith(`${name}, `), NAME);
  if (!(await page.locator("#pet").isVisible())) await page.locator("#rail-toggle").click();
  const m = await measure(page);
  assert.deepEqual([m.acorn, m.inset, m.above, m.below, m.beside, m.pet], [[58, 58], 18, 12, 8, 10, [60, 54]]);
  assert.equal(m.words, "");
  assert.match(await page.locator("#pet").getAttribute("aria-label"), new RegExp(`^${NAME}, `));
  assert.deepEqual(errors, []);
});

/* DG-138: the 3D acorn and pets are the approved sample's shapes, drawn by the window's own WebGL. */
// Redesign: replaced by the new window (prototype.html's pets are the pixel pets of shell/scene.js; no WebGL acorn
// or 3D pets; "The oak in 3D" background is Coming soon, bgset-oak3d).
test.skip("3D: the acorn and the pets are the sample's shapes, faceted where it is, in colours from the tokens", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 1440, scheme: "dark", everything: false });
  const shapes = await page.evaluate(async () => {
    const { acornModel, petModel } = await import("/delight-3d.js");
    const high = (part) => Math.max(...part.positions.filter((_, i) => i % 3 === 1));
    const acorn = acornModel(), squirrel = petModel("squirrel"), rabbit = petModel("rabbit"), snail = petModel("snail");
    document.documentElement.style.setProperty("--model-acorn-cap", "rgb(255, 0, 0)");
    const recoloured = acornModel()[1].color;
    document.documentElement.style.removeProperty("--model-acorn-cap");
    return {
      acorn: acorn.map((part) => [part.flat, part.indices.length]), capTop: high(acorn[1]), stemTop: high(acorn[2]),
      squirrel: squirrel.length, rabbitEar: high(rabbit[3]) - high(squirrel[3]), snail: snail.length, snailFlat: snail.at(-1).flat,
      owl: petModel("owl").length, unknown: petModel("dragon").length, recoloured,
    };
  });
  // the nut 14×10 and smooth; the cap the top half of 12×12, faceted; the stem a six-sided faceted cylinder
  assert.deepEqual(shapes.acorn, [[false, 14 * 10 * 6], [true, 12 * 6 * 6], [true, 6 * 6]]);
  assert.ok(Math.abs(shapes.capTop - (0.1 + 0.385)) < 1e-9 && Math.abs(shapes.stemTop - 0.77) < 1e-9, "sized and placed as in the sample");
  assert.equal(shapes.squirrel, 8, "body, head, belly, two ears, two eyes and a tail");
  assert.ok(Math.abs(shapes.rabbitEar - 0.36) < 1e-9, "the rabbit's ears stand taller");
  assert.deepEqual([shapes.snail, shapes.snailFlat, shapes.owl, shapes.unknown], [8, true, 7, 8]);
  assert.deepEqual(shapes.recoloured, [1, 0, 0], "the colours are the tokens'");
  await page.evaluate(() => fetch("/api/delight/settings", {
    method: "POST",
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
    body: JSON.stringify({ look: { style: "3d" } }),
  }).then(() => globalThis.branchDelight.reload()));
  await page.locator("#acorn-3d").waitFor();
  await page.locator("#pet .pet-3d").waitFor();
  const drawn = await page.locator("#acorn-3d").evaluate((canvas) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d");
    g.drawImage(canvas, 0, 0);
    const box = canvas.getBoundingClientRect();
    return { size: [box.width, box.height], ink: g.getImageData(0, 0, copy.width, copy.height).data.some((value, i) => i % 4 === 3 && value > 0) };
  });
  assert.deepEqual(drawn, { size: [58, 58], ink: true }, "the 3D acorn is drawn at the tile's 58px");
  assert.deepEqual(errors, []);
});
