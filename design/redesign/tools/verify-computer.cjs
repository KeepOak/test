// Clicks every control the computer & browser stage and the Terminal tab made live, and checks each against the engine.
// First seed a fresh data folder and start the engine on it:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<ws> node design/redesign/tools/seed-computer.mjs
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<ws> BRANCH_PORT=<port> node dist/cli.js start
// then: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-computer.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const get = async (path) => {
  const r = await fetch(BASE + "/api/" + path, { headers: { authorization: "Bearer " + TOKEN } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};
const results = [];
const check = (what, ok, detail = "") => { results.push([ok ? "PASS" : "FAIL", what, detail]); if (!ok) process.exitCode = 1; };

(async () => {
  const state = await get("state");
  const waiting = state.runs.find((r) => r.status === "needs_input");
  if (!waiting) throw new Error("No waiting task: run seed-computer.mjs on a fresh data folder first");
  const session = waiting.sessionId;
  const work = await get(`panels/work?session=${session}`);
  const messages = (await get(`sessions/${session}`)).messages;
  const deskCall = messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.name === "desktop.screenshot");
  const deskPath = JSON.parse(messages.find((m) => m.role === "tool" && m.toolCallId === deskCall.id).content).result.path;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [], pictures = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === "/api/artifacts/file") pictures.push(u.searchParams.get("path")); });
  await fetch(BASE + "/api/onboarding", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ done: true }) }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(`[data-act="chat"][data-id="${session}"]`).waitFor();
  // The window's first request before sign-in is refused (401) by design; errors count from here on.
  errors.length = 0;
  await page.locator(`[data-act="chat"][data-id="${session}"]`).click();
  await page.keyboard.press("Control+Shift+K");

  // Terminal tab: the commands the engine lists, in order, with what came back.
  await page.locator('#pane [data-act="ptabp"][data-p="terminal"]').click();
  await page.locator("#pane .termrow code").first().waitFor();
  const shown = await page.locator("#pane .termrow code").allTextContents();
  check("Terminal tab lists panels/work terminal commands", JSON.stringify(shown) === JSON.stringify(work.terminal.entries.map((e) => "$ " + e.what)), JSON.stringify(shown));
  const out = await page.locator("#pane .termrow pre").allTextContents();
  check("Terminal tab shows what each command printed", JSON.stringify(out) === JSON.stringify(work.terminal.entries.filter((e) => e.output).map((e) => e.output)), JSON.stringify(out));
  // unhold-control: it is live now (verify-unhold-control.cjs runs a command through it).
  check("'Open a terminal for me' is live", (await page.locator('#pane [data-act="shell"]').getAttribute("aria-disabled")) !== "true");

  // Browser tab opens the full-size view of the browser, showing the engine's last picture.
  await page.locator('#pane [data-act="stage"][data-v="browser"]').click();
  await page.locator("#stage7 img.shot7").waitFor();
  // The seeder's browser picture is 64 wide and its desktop picture 48 wide, so each view's picture can be told apart.
  const width = () => page.evaluate(() => document.querySelector("#stage7 img.shot7")?.naturalWidth ?? 0);
  const settle = (w) => page.waitForFunction((w) => document.querySelector("#stage7 img.shot7")?.naturalWidth === w, w, { timeout: 5000 }).catch(() => null);
  await settle(64);
  check("stage (browser) shows panels/work browser.picture", pictures.includes(work.browser.picture) && (await width()) === 64, pictures.join(" | "));
  const shotPage = work.browser.entries.filter((e) => e.tool === "browser.screenshot").at(-1).what;
  check("stage (browser) names the page the picture was taken on", (await page.locator("#stage7 .dk-url").textContent()) === shotPage);
  check("stage title uses the engine's assistant name", (await page.locator("#stage7 .st7-title b").textContent()) === `${state.identity.name}’s browser`);

  // The switch shows the computer: the newest desktop.screenshot the conversation kept.
  await page.locator('#stage7 .st7-sw [data-v="computer"]').click();
  await settle(48);
  check("stage (computer) shows the conversation's desktop.screenshot", pictures.includes(deskPath) && (await width()) === 48);
  check("stage switch marks Computer", (await page.locator('#stage7 .st7-sw [data-v="computer"]').getAttribute("aria-pressed")) === "true");
  // Switching never shows the other view's picture, not even for a moment.
  await page.locator('#stage7 .st7-sw [data-v="browser"]').click();
  const shown1 = await page.evaluate(() => document.querySelector("#stage7 img.shot7")?.src);
  await settle(64);
  check("switching back shows the browser's own picture", (await width()) === 64 && shown1 === (await page.evaluate(() => document.querySelector("#stage7 img.shot7")?.src)));
  await page.locator('#stage7 .st7-sw [data-v="computer"]').click();
  const shown2 = await page.evaluate(() => document.querySelector("#stage7 img.shot7")?.src);
  await settle(48);
  check("and the computer's own picture", (await width()) === 48 && shown2 === (await page.evaluate(() => document.querySelector("#stage7 img.shot7")?.src)));

  // Window-state controls.
  await page.locator('#stage7 [data-act="stage-dock"]').click();
  check("stage-dock hides the conversation", (await page.locator("#stage7 .st7-dock").count()) === 0);
  await page.locator('#stage7 [data-act="stage-dock"]').click();
  check("stage-dock shows it again", (await page.locator("#stage7 .st7-dock").count()) === 1);
  await page.locator('#stage7 [data-act="stage-pip"]').click();
  check("stage-pip moves the view to a small window", (await page.locator("#stage7").count()) === 0 && (await page.locator("#pip7 img.shot7").count()) === 1);
  await page.locator('#pip7 .pip7-bar [data-act="stage"]').click();
  check("the small window opens full size again", (await page.locator("#stage7").count()) === 1 && (await page.locator("#pip7").count()) === 0);
  await page.locator('#stage7 [data-act="stage-pip"]').click();
  await page.locator('#pip7 [data-act="pip-x"]').click();
  check("pip-x closes the small window", (await page.locator("#pip7").count()) === 0);
  await page.locator('#pane [data-act="stage"][data-v="browser"]').click();
  await page.locator('#stage7 [data-act="stage-close"]').click();
  check("stage-close closes the view", (await page.locator("#stage7").count()) === 0);
  await page.locator('#pane [data-act="stage"][data-v="browser"]').click();
  await page.keyboard.press("Escape");
  check("Escape closes the view", (await page.locator("#stage7").count()) === 0);

  // Stop: the waiting task is cancelled in the engine. Take over is the shared Linux desktop's (verify-unhold-control.cjs):
  // with none running it is not drawn.
  await page.locator('#pane [data-act="stage"][data-v="browser"]').click();
  const desk = await get("linux-desktop");
  check("Take over is not drawn while no shared desktop runs (GET /api/linux-desktop)", !desk.running && (await page.locator('#stage7 [data-act="takeover"]').count()) === 0);
  await page.locator('#stage7 [data-act="stage-stop"]').click();
  await page.locator("#stage7").waitFor({ state: "detached" });
  const after = (await get("state")).runs.find((r) => r.id === waiting.id);
  check("stage-stop cancels the task (GET /api/state)", after?.status === "cancelled", after?.status);

  await browser.close();
  check("no page errors", errors.length === 0, errors.join(" | "));
  for (const r of results) console.log(r.join("  "));
})().catch((e) => { console.error(e); process.exit(1); });
