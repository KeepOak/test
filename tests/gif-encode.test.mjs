/* SCREEN-164: the task GIF is a real, bounded GIF that a browser decodes: 320 x 240, looping, the frames' colours kept,
   at most 20 frames and 2 MB. The encoder is the window's own module; a headless Chromium decodes what it wrote. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gifBytes, gifPalette } from "../public/app/chat/gif-encode.js";

const solid = (r, g, b) => { const rgba = new Uint8ClampedArray(320 * 240 * 4); for (let i = 0; i < rgba.length; i += 4) rgba.set([r, g, b, 255], i); return gifPalette(rgba); };

test("SCREEN-164: two sampled frames make a GIF a browser draws at 320 x 240 in their colours", { timeout: 60000 }, async (t) => {
  const bytes = gifBytes([solid(255, 0, 0), solid(0, 0, 255)]);
  assert.equal(Buffer.from(bytes.subarray(0, 6)).toString("ascii"), "GIF89a");
  assert.equal(bytes.at(-1), 0x3b, "the file is closed properly");
  assert.ok(bytes.length < 2 * 1024 * 1024);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const drawn = await page.evaluate(async (base64) => {
    const image = new Image(); image.src = `data:image/gif;base64,${base64}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const g = canvas.getContext("2d"); g.drawImage(image, 0, 0);
    return { width: image.naturalWidth, height: image.naturalHeight, pixel: [...g.getImageData(160, 120, 1, 1).data.slice(0, 3)] };
  }, Buffer.from(bytes).toString("base64"));
  assert.deepEqual([drawn.width, drawn.height], [320, 240]);
  assert.deepEqual(drawn.pixel, [255, 0, 0], "the first frame shows, red");
});

test("SCREEN-164: fewer than two, more than twenty, or wrongly sized frames make no GIF", () => {
  assert.throws(() => gifBytes([solid(0, 0, 0)]), /unavailable/);
  assert.throws(() => gifBytes(Array.from({ length: 21 }, () => solid(0, 0, 0))), /unavailable/);
  assert.throws(() => gifBytes([new Uint8Array(10), new Uint8Array(10)]), /Invalid GIF frame/);
  assert.throws(() => gifBytes([solid(0, 0, 0), solid(0, 0, 0)], 640, 480), /unavailable/);
  assert.ok(gifBytes(Array.from({ length: 20 }, (_, i) => solid(i * 12, 0, 0))).length < 2 * 1024 * 1024, "twenty frames fit the 2 MB limit");
});
