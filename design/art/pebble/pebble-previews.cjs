/* Previews of the packed pebble art, drawn by the window's own code (core/pebble.js pebbleFrame, the same composite
   every face uses) in a real browser: a contact sheet of every state in the eight colours, five shapes and three eye
   styles on light and dark, and a GIF per state.
     node design/art/pebble/pebble-previews.cjs <out folder>
   It starts its own engine in a temp folder, with a model that only says hello (nothing is sent anywhere). */
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const COLOURS = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"];
const EYES = ["round", "wide", "sleepy"];
const STATES = ["idle", "think", "search", "read", "work", "wait", "talk", "yay", "oops", "sleep", "hover", "pat", "wake"];
const CELL = 128;

/* In the page: one row per state, a representative frame per face, drawn with the window's composite. */
async function contact(page, bg) {
  return page.evaluate(async ({ STATES, COLOURS, EYES, CELL, bg }) => {
    const { pebbleFrame } = await import("/app/core/pebble.js");
    const out = Object.assign(document.createElement("canvas"), { width: CELL * 8, height: CELL * STATES.length });
    const g = out.getContext("2d");
    g.fillStyle = bg;
    g.fillRect(0, 0, out.width, out.height);
    const cell = Object.assign(document.createElement("canvas"), { width: CELL, height: CELL });
    for (const [row, state] of STATES.entries()) {
      for (let col = 0; col < 8; col++) {
        cell.getContext("2d").clearRect(0, 0, CELL, CELL);
        const m = await pebbleFrame(cell, { state, shape: col % 5, eyes: EYES[col % 3], colour: COLOURS[col], frame: 0 });
        cell.getContext("2d").clearRect(0, 0, CELL, CELL);
        await pebbleFrame(cell, { state, shape: col % 5, eyes: EYES[col % 3], colour: COLOURS[col], frame: Math.floor(m.frames * (0.35 + 0.08 * (col % 4))) });
        g.drawImage(cell, col * CELL, row * CELL);
      }
    }
    return out.toDataURL("image/png");
  }, { STATES, COLOURS, EYES, CELL, bg });
}

/* In the page: every frame of one state, three faces side by side. */
async function strip(page, state) {
  return page.evaluate(async ({ state, COLOURS, CELL }) => {
    const { pebbleFrame } = await import("/app/core/pebble.js");
    const faces = [{ shape: 0, eyes: "round", colour: COLOURS[0] }, { shape: 2, eyes: "wide", colour: COLOURS[1] }, { shape: 4, eyes: "sleepy", colour: COLOURS[4] }];
    const cell = Object.assign(document.createElement("canvas"), { width: CELL, height: CELL });
    const out = Object.assign(document.createElement("canvas"), { width: CELL * 3, height: CELL });
    const g = out.getContext("2d");
    const first = await pebbleFrame(cell, { state });
    const frames = [];
    for (let i = 0; i < first.frames; i++) {
      g.fillStyle = "#f7f4ee";
      g.fillRect(0, 0, out.width, out.height);
      for (const [k, f] of faces.entries()) {
        cell.getContext("2d").clearRect(0, 0, CELL, CELL);
        await pebbleFrame(cell, { state, frame: i, ...f });
        g.drawImage(cell, k * CELL, 0);
      }
      frames.push(out.toDataURL("image/png"));
    }
    return { fps: first.fps, frames };
  }, { state, COLOURS, CELL });
}

const png = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

(async () => {
  const out = process.argv[2];
  mkdirSync(out, { recursive: true });
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "pebble-previews-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.waitForTimeout(3000);
    writeFileSync(join(out, "contact-light.png"), png(await contact(page, "#f7f4ee")));
    writeFileSync(join(out, "contact-dark.png"), png(await contact(page, "#1c1c1f")));
    for (const state of STATES) {
      const { fps, frames } = await strip(page, state);
      const dir = mkdtempSync(join(tmpdir(), `pebble-${state}-`));
      frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(4, "0")}.png`), png(f)));
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "%04d.png"),
        "-vf", "split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a", "-loop", "0", join(out, `${state}.gif`)]);
      rmSync(dir, { recursive: true, force: true });
      console.log(`${state}.gif`, frames.length, "frames at", fps, "fps");
    }
  } finally {
    await browser.close();
    await server.close().catch(() => {});
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
