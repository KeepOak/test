// Checks the Trunk's cursor, Take over and Hand back in the full-size computer view, each confirmed through the engine.
//   node design/redesign/tools/verify-screen-driving.cjs
// It never uses this computer's real screen: it starts its own engine in-process (a temp folder, a free port) whose screen
// is a stand-in (the frames are a plain picture and the clicks are written down), because a reviewer's engine would show
// the real screen. A task keeps working (its model call waits) so the view offers Take over.
// 1. A task's click at the middle of the screen: the Trunk's cursor is drawn there, with a name.
// 2. takeover (data-v="screen"): POST /api/panels/screen/take-over; the view says You're driving; the engine holds the
//    task's next click (app.desktop.isDriving(), and the stand-in saw no click).
// 3. handback (data-v="screen"): POST /api/panels/screen/hand-back; the held click happens; the banner goes.
// A safety belt: with this set, Branch's real-screen guard (src/integrations/real-screen-guard.ts) refuses the real screen
// to anything in this process that is not the stand-in.
process.env.NODE_TEST_CONTEXT ??= "verify-screen-driving";
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { deflateSync, crc32 } = require("node:zlib");

let failures = 0;
const check = (ok, what, note = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${what}${note ? `  (${note})` : ""}`); if (!ok) failures++; };
function picture() {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc32(body)); return Buffer.concat([n, body, c]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(16, 0); head.writeUInt32BE(10, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 10 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(48, 0x55)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const dist = join(__dirname, "../../../dist/");
  const load = (file) => import(pathToFileURL(join(dist, file)).href);
  const [{ createBranch }, { startServer }, { DesktopControl }, { saveDesktopSettings }] = await Promise.all([load("index.js"), load("server.js"), load("integrations/desktop.js"), load("integrations/desktop-config.js")]);
  const root = mkdtempSync(join(tmpdir(), "verify-driving-"));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "held", async complete(request) { await Promise.race([held, new Promise((r) => request.signal.addEventListener("abort", r, { once: true }))]); return { content: "Done.", toolCalls: [] }; } } });
  const calls = [], data = picture().toString("base64");
  const reader = { running: true, close() {}, async frame() { return { width: 16, height: 10, data, windows: [], after: [], screen: { x: 0, y: 0, w: 1280, h: 800 } }; } };
  const runner = { liveProcess: () => reader, async temporaryPng(n) { return join(root, `${n}.png`); }, async close() {},
    async run(action, payload) { calls.push(action); if (action === "windows") return { windows: [{ title: "Notes", program: "stand-in", handle: 7, minimised: false }] }; if (action === "click") return { how: "point", name: "", at: [100 + payload.x, 50 + payload.y] }; return {}; } };
  app.desktop = new DesktopControl(app.store, { runner, banner: { visible: false, show: async () => undefined, hide: async () => undefined } });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  try {
    await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    let run;
    await new Promise((resolve) => { void app.runtime.run({ prompt: "Tidy my notes", onTextDelta: () => undefined, onStarted: (r) => { run = r; resolve(); } }).catch(() => undefined); });
    const context = () => app.runtime.context({ runId: run.id });
    await app.desktop.click({ window: "Notes", point: { x: 540, y: 350 } }, context());
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click();
    await page.locator('[data-act="stage"][data-v="computer"]').first().click();
    await page.locator("#stage7 .real-ag").waitFor({ state: "visible", timeout: 20000 });
    const place = await page.evaluate(() => { const d = document.querySelector("#stage7 .desk7"), m = document.querySelector("#stage7 .real-ag"); return { x: parseFloat(m.style.left) / d.clientWidth, y: parseFloat(m.style.top) / d.clientHeight, name: m.textContent }; });
    check(Math.abs(place.x - 0.5) < 0.01 && Math.abs(place.y - 0.5) < 0.01 && place.name, "the Trunk's cursor is drawn where its task clicked, with a name", JSON.stringify(place));
    await page.locator('#stage7 [data-act="takeover"][data-v="screen"]').click();
    await page.locator("#stage7 .you7").waitFor({ timeout: 10000 });
    const before = calls.length;
    let clicked = false;
    const waiting = app.desktop.click({ window: "Notes", point: { x: 1, y: 1 } }, context()).then(() => { clicked = true; });
    await page.locator('#stage7 [data-act="handback"][data-v="screen"]').waitFor();
    check(app.desktop.isDriving() && /You’re driving/.test(await page.locator("#stage7 .you7").innerText()) && !clicked && calls.length === before,
      "takeover: POST /api/panels/screen/take-over; You're driving; the task's click waits");
    await page.locator('#stage7 [data-act="handback"][data-v="screen"]').click();
    await waiting;
    check(!app.desktop.isDriving() && clicked, "handback: POST /api/panels/screen/hand-back; the held click happens");
    await page.locator("#stage7 .you7").waitFor({ state: "detached" });
    check(errors.length === 0, "no page errors", errors.join("; "));
  } finally {
    release();
    await browser.close();
    await server.close().catch(() => {});
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
