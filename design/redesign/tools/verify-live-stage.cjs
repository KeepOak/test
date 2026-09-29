/* live-stage: the full-size view of Branch's browser shows what a real task's browser sees, as it works.
   Everything is driven through the real window and read back from the engine's own GET routes; page errors must be zero.
   A real engine browser run: this script serves two small pages on this computer (PAGE_PORT, default 43861) and runs a
   small OpenAI-shaped model (MODEL_PORT, default 43862) that calls Branch's real browser.navigate tool and holds its next
   reply until the checks are done, so the task really is working while it is watched. Start a THROWAWAY engine with a
   launch file that lets Branch's browser open the page server:
     echo '{"web":{"allowPrivateAddresses":true},"browser":{"allowedOrigins":["http://127.0.0.1:43861"]}}' > launch.json
     BRANCH_INTEGRATIONS=launch.json BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> \
     BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43862/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify \
     node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-live-stage.cjs
   It proves: the empty view is themed, sized to its words and never covers the welcome card; a message sent from the
   view's dock starts a real task that asks for its yes; the view then shows live frames of Branch's browser (the page's colour, its address, its
   title, the step the engine names, password boxes covered) and follows the task to its next page; picture in picture
   and the docked conversation (hide, show, drag its edge, steer the task from its box) work; Stop cancels the task
   (GET /api/runs/<id>); Team's Watch opens the live view; the Trunk computer chips, At once and the view's computer
   menu change GET /api/trunks/<id>/computers; and a household person is refused the owner's frames while they are live.
   It CHANGES the engine, so run it on a throwaway one only: the approval policy is set to "Just do it inside my workspace"
   (put back at the end with confirmLoosening), an "Always" yes is given for 127.0.0.1:<PAGE_PORT>, a Trunk "Verify
   Stage" and a household profile "Sam" (PIN 2468) are made, the Trunk's computers are changed and put back, and the
   light/dark switch is flipped twice.
   Screenshots go to SHOTS (default C:/Users/bishi/AppData/Local/Temp/claude-session-files/live-stage). */
const http = require("node:http");
const { createHash } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");

const { PORT, TOKEN } = process.env;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
if (PORT === "3210" || PORT === "3300") { console.error("Never the owner's app or preview."); process.exit(2); }
const PAGE_PORT = Number(process.env.PAGE_PORT || 43861), MODEL_PORT = Number(process.env.MODEL_PORT || 43862);
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/live-stage";
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, PAGES = `http://127.0.0.1:${PAGE_PORT}`;
const wire = (name) => "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function until(what, test, ms = 30000) {
  for (let t = 0; t < ms; t += 250) { const v = await test().catch(() => null); if (v) return v; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
async function call(route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${route}: ${r.status} ${data.error ?? ""}`), { status: r.status });
  return data;
}

/* ---------- two pages for Branch's browser: green with a filled password box (and a strict style-src), then blue ---------- */
const PAGE = (title, colour, extra) => `<!doctype html><html><head><title>${title}</title></head><body bgcolor="${colour}">${extra}<h1>${title}</h1></body></html>`;
function startPages() {
  const server = http.createServer((req, res) => {
    const one = req.url.startsWith("/one");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'none'" });
    res.end(one ? PAGE("Live page one", "#1f9d55", '<input type="password" value="correct-horse-battery-staple" size="150">') : PAGE("Live page two", "#1f4fd1", ""));
  });
  return new Promise((ready, fail) => { server.on("error", fail); server.listen(PAGE_PORT, "127.0.0.1", () => ready(server)); });
}

/* ---------- the model: opens the address it was asked to, holds, opens page two, holds, answers ---------- */
const model = { held: [], bodies: 0 };
const textOf = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
function reply(body) {
  const msgs = body.messages ?? [];
  // The address is in the asking message. Each page is opened once it has its yes (a yes carried on reads "Yes, go
  // ahead." and the call is made again, now allowed); right after a page opens, the next reply is held until released.
  const asked = msgs.filter((m) => m.role === "user").map((m) => /(https?:\/\/127\.0\.0\.1:\d+\/one)/.exec(textOf(m))).filter(Boolean).at(-1);
  if (!asked) return { content: "Answered." };
  const opened = (title) => msgs.some((m) => m.role === "tool" && textOf(m).includes(title));
  // The page just opened: the newest step's result names it, with no reply since (a steered note may follow it).
  const last = msgs.findLastIndex((m) => m.role === "tool");
  const justNow = (title) => last >= 0 && textOf(msgs[last]).includes(title) && !msgs.slice(last + 1).some((m) => m.role === "assistant");
  if (!opened("Live page one")) return { tool: { name: "browser.navigate", arguments: { url: asked[1] } } };
  if (!opened("Live page two")) return { hold: justNow("Live page one"), tool: { name: "browser.navigate", arguments: { url: `${PAGES}/two` } } };
  return { hold: justNow("Live page two"), content: "Done." };
}
function respond(res, body, r) {
  const message = r.tool ? { role: "assistant", content: null, tool_calls: [{ id: `c${Date.now()}${Math.random().toString(16).slice(2, 6)}`, type: "function", function: { name: wire(r.tool.name), arguments: JSON.stringify(r.tool.arguments) } }] } : { role: "assistant", content: r.content };
  const finish = message.tool_calls ? "tool_calls" : "stop", usage = { prompt_tokens: 10, completion_tokens: 5 };
  if (res.destroyed) return;
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : { content: message.content };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}
function startModel() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "verify", object: "model" }] })); return; }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); return; }
      model.bodies += 1;
      const r = reply(body);
      if (process.env.DEBUG) console.log("model:", JSON.stringify(r).slice(0, 120), "offered navigate:", JSON.stringify(body.tools ?? []).includes(wire("browser.navigate")), (body.tools ?? []).length);
      if (r.hold) model.held.push(() => respond(res, body, r)); else respond(res, body, r);
    });
  });
  return new Promise((ready, fail) => { server.on("error", fail); server.listen(MODEL_PORT, "127.0.0.1", () => ready(server)); });
}
const release = () => { for (const r of model.held.splice(0)) r(); };

/* ---------- the window ---------- */
async function signIn(page) {
  await page.addInitScript(() => { try { localStorage.setItem("branch-setup-seen", "1"); localStorage.removeItem("branch-welcomed"); localStorage.removeItem("branch-stage-dock-w"); } catch (error) { console.error(error.message); } });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
}
/* Gets somewhere the way the window routes a click (for moving about, not for the control under test). */
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
}
const stage = (page) => page.locator("#stage7");
/* The centre pixel (or one at x,y of the frame's own size) of the live frame, read off the picture in the page. */
const framePixel = (page, sel, x, y) => page.evaluate(async ([s, px, py]) => {
  const img = document.querySelector(s);
  if (!img?.getAttribute("src")?.startsWith("data:image/jpeg")) return null;
  await img.decode().catch(() => null);
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(px ?? Math.floor(c.width / 2), py ?? Math.floor(c.height / 2), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [sel, x, y]);
const greenish = (p) => p && p[1] > 120 && p[0] < 90 && p[2] < 130;
const blueish = (p) => p && p[2] > 150 && p[0] < 90;


const liveNow = (sid) => call(`panels/live?session=${encodeURIComponent(sid)}`);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

/* ---------- 1: nothing opened yet ---------- */
async function emptyState(page) {
  const sid = (await call("run", { prompt: "hello" })).sessionId;
  await act(page, "chat", { id: sid });
  await page.locator("#prompt").waitFor();
  await act(page, "stage", { v: "browser" });
  const empty = page.locator("#stage7 .st7-empty");
  await empty.waitFor({ timeout: 15000 });
  await page.locator(".welcome10").waitFor({ timeout: 15000 });
  check("empty: the view draws one line, no blank page", (await page.locator("#stage7 .st7-screen").count()) === 0 && (await empty.innerText()).includes("Nothing open"));
  for (const round of [1, 2]) {
    const look = await page.evaluate(() => {
      const el = document.querySelector("#stage7 .st7-empty"), wrap = document.querySelector("#stage7 .st7-wrap");
      const probe = document.createElement("i"); probe.style.color = "var(--raise)"; document.body.appendChild(probe);
      const raise = getComputedStyle(probe).color; probe.remove();
      const e = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      const card = document.querySelector(".welcome10"), c = card?.getBoundingClientRect();
      const top = c ? document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) : null;
      return { theme: document.documentElement.dataset.theme || "system", bg: getComputedStyle(el).backgroundColor, raise, small: e.height < w.height * 0.6 && e.width < w.width,
        welcome: !!card, onTop: !!top && card.contains(top), welcomeBg: card ? getComputedStyle(card).backgroundColor : "" };
    });
    check(`empty (${look.theme}): drawn in the theme's own colour, not white`, look.bg === look.raise && (look.theme === "light" || look.bg !== "rgb(255, 255, 255)"), `${look.bg} vs --raise ${look.raise}`);
    check(`empty (${look.theme}): sized to its words`, look.small);
    check(`empty (${look.theme}): the welcome card is shown on top of the view, not covered`, look.welcome && look.onTop);
    check(`empty (${look.theme}): the welcome card has a fill of its own`, look.welcomeBg && !/rgba\(0, 0, 0, 0\)|transparent/.test(look.welcomeBg), look.welcomeBg);
    await shot(page, `empty-${look.theme}`);
    await page.locator('[data-act="theme-flip"]').first().click();
    await sleep(400);
  }
  return sid;
}

/* ---------- 2: a message from the dock, its yes, and the live view ---------- */
async function openPage(page, sid) {
  check("the empty view has no control the prototype does not draw", (await page.locator("#stage7 #st-open, #stage7 .st7-open").count()) === 0);
  await page.fill("#st-in", `Open ${PAGES}/one in your browser.`);
  await page.press("#st-in", "Enter");
  const waiting = await until("the task's question", async () => (await call("policy")).waiting.find((w) => w.sessionId === sid), 30000);
  check("dock: with nothing working its box sends the conversation a message; a real task asks its yes to open the page (GET /api/policy waiting)", waiting && /browser/.test(JSON.stringify(waiting)), waiting?.tool ?? "");
  await until("the view to say it needs you", async () => (await page.locator("#stage7 .pill.warn").count()) === 1, 15000);
  check("the view says the task needs you", true);
  await page.locator("#stage7 .st7-back").click();
  // "Always" for this site (on this throwaway engine), so the task's next page on it goes ahead without asking again.
  await page.locator('#live-ask [data-act="ask-always"]').click({ timeout: 20000 });
  await act(page, "stage", { v: "browser" });
  const green = await until("a live frame of page one", async () => greenish(await framePixel(page, "#stage7 .live7-img")) && true, 30000);
  check("live: the view shows a frame of the page Branch's browser has open (page one's green)", green);
  const live = await liveNow(sid);
  check("live: GET /api/panels/live says live, with the page's address and title", live.browser?.live === true && live.browser.url === `${PAGES}/one` && live.browser.title === "Live page one", JSON.stringify({ url: live.browser?.url, title: live.browser?.title }));
  check("live: the address bar shows the real address", (await page.locator("#stage7 .dk-url").innerText()).includes(`${PAGES}/one`));
  check("live: the tab shows the page's title", (await page.locator("#stage7 .dk-tabs .on7").innerText()) === "Live page one");
  const pw = await framePixel(page, "#stage7 .live7-img", 300, 18);
  check("live: the password box is covered in the frame (strict style-src page)", pw && pw[0] < 40 && pw[1] < 40 && pw[2] < 40, JSON.stringify(pw));
  const cap = (await page.locator("#stage7 .st7-cap").innerText().catch(() => "")).trim();
  const said = (await liveNow(sid)).doing;
  check("live: the caption is what the engine says the task is doing", cap && cap === said, `${cap} / ${said}`);
  check("live: the view names Branch's own browser", (await page.locator("#stage7 .st7-sub").count()) === 1);
  await shot(page, "live-page-one");
  return live.runId;
}

/* ---------- 3: the docked conversation and picture in picture ---------- */
async function dockAndPip(page, runId) {
  await page.fill("#st-in", "Keep going please");
  await page.press("#st-in", "Enter");
  await page.locator(".toast", { hasText: "It reads it before its next step." }).waitFor({ timeout: 10000 });
  const steering = (await call(`runs/${runId}/inspect`)).steering ?? [];
  check("dock: its box steers the working task (GET /api/runs/<id>/inspect)", steering.some((n) => n.text.includes("Keep going please")));
  const dockW = () => page.evaluate(() => document.querySelector("#stage7 .st7-dock")?.getBoundingClientRect().width ?? 0);
  await page.locator('#stage7 [data-act="stage-dock"]').click();
  check("dock: hidden, the screen has the width", (await page.locator("#stage7 .st7-dock").count()) === 0);
  await page.locator('#stage7 [data-act="stage-dock"]').click();
  check("dock: shown again", (await page.locator("#stage7 .st7-dock").count()) === 1);
  const w0 = await dockW(), edge = await page.locator('#stage7 [data-resize="dock"]').boundingBox();
  await page.mouse.move(edge.x + 3, edge.y + 200); await page.mouse.down(); await page.mouse.move(edge.x - 117, edge.y + 200, { steps: 6 }); await page.mouse.up();
  const w1 = await dockW();
  check("dock: dragging its edge widens it", Math.abs(w1 - w0 - 120) <= 8, `${w0} → ${w1}`);
  await page.locator('#stage7 [data-resize="dock"]').focus(); await page.keyboard.press("ArrowRight");
  check("dock: the arrow keys move its edge", Math.abs((await dockW()) - (w1 - 16)) <= 2);
  await page.locator('#stage7 [data-resize="dock"]').dblclick();
  await page.locator(".toast", { hasText: "Back to the usual size." }).waitFor({ timeout: 5000 });
  check("dock: a double-click puts it back to the usual width", Math.abs((await dockW()) - 340) <= 2);
  await page.locator('#stage7 [data-act="stage-pip"]').click();
  await page.locator("#pip7").waitFor();
  check("picture in picture: the view shrinks to the small window", (await stage(page).count()) === 0);
  check("picture in picture: it shows the live frame too", await until("a frame in the small window", async () => greenish(await framePixel(page, "#pip7 .live7-img")), 10000));
  await shot(page, "pip");
  await page.locator('#pip7 .pip7-bar [data-act="stage"]').click();
  check("picture in picture: Open full size brings the view back", (await stage(page).count()) === 1 && (await page.locator("#pip7").count()) === 0);
  await page.locator('#stage7 [data-act="stage-pip"]').click();
  await page.locator('#pip7 [data-act="pip-x"]').click();
  check("picture in picture: closing it leaves the conversation", (await page.locator("#pip7").count()) === 0 && (await stage(page).count()) === 0);
}

/* ---------- 4: it follows the task, Team's Watch, a household person, Stop ---------- */
async function follow(page, sid) {
  await act(page, "stage", { v: "browser" });
  release();
  check("live: the view follows the task to its next page (page two's blue)", await until("a frame of page two", async () => blueish(await framePixel(page, "#stage7 .live7-img")), 30000));
  await until("page two's address", async () => (await page.locator("#stage7 .dk-url").innerText()).includes("/two"), 10000);
  check("live: the address bar follows it", true);
  await shot(page, "live-page-two");
  const runId = (await liveNow(sid)).runId;
  await page.locator("#stage7 .st7-back").click();
  check("the conversation shows the prototype's card while the task works in the browser, with its live picture",
    await until("the card's picture", async () => blueish(await framePixel(page, "#main .comp7 .live7-img")), 15000));
  await shot(page, "conversation-card");
  await page.locator('#main .comp7 .acts [data-act="stage"]').click();
  check("the card's Watch full size opens the view", await until("the view from the card", async () => (await page.locator("#stage7 .live7-img").count()) === 1, 10000));
  await page.locator("#stage7 .st7-back").click();
  await act(page, "view", { v: "team" });
  await page.locator(`[data-act="run-watch"][data-id="${runId}"]`).click({ timeout: 15000 });
  check("Team › Live now › Watch opens that task's browser, live", await until("the watched frame", async () => blueish(await framePixel(page, "#stage7 .live7-img")), 15000));
  return runId;
}
async function household(sid) {
  const sam = (await call("profiles")).profiles?.find((p) => p.name === "Sam") ?? await call("profiles", { name: "Sam", pin: "2468" });
  await call("profiles/switch", { profileId: sam.id, pin: "2468" });
  let refused = null;
  try { await call(`panels/live?session=${encodeURIComponent(sid)}`); } catch (error) { refused = error; }
  await call("profiles/switch", { profileId: null });
  check("household: Sam is refused the owner's live frames while they are live", refused && refused.status >= 400 && /belongs to the owner/.test(refused.message), refused?.message ?? "answered");
  check("household: back as the owner, the frames are still there", (await liveNow(sid)).browser?.live === true);
}
async function stop(page, sid, runId) {
  await page.locator(`#stage7 [data-act="stage-stop"][data-id="${runId}"]`).click();
  const done = await until("the task to stop", async () => { const r = await call(`runs/${runId}`); return r.run?.status === "cancelled" && r.run.status; }, 20000);
  check("Stop: the task is cancelled (GET /api/runs/<id>)", done === "cancelled");
  const after = await until("the last frame", async () => { const v = await liveNow(sid); return v.browser && v.browser.live === false && v.browser; }, 15000);
  check("after Stop: the engine keeps the last frame, not live", after.url.endsWith("/two"));
  await until("the view idle", async () => (await page.locator("#stage7 .pill.idle").count()) === 1, 10000);
  check("after Stop: the view shows where it finished, idle", blueish(await framePixel(page, "#stage7 .live7-img")));
  await shot(page, "after-stop");
  release();
}

/* ---------- 5: the Trunk computer controls ---------- */
async function computers(page) {
  const made = await call("trunks", { name: "Verify Stage", description: "Checks the computer chips." });
  const id = (made.trunk ?? made).id;
  const read = () => call(`trunks/${id}/computers`);
  const before = await read();
  await page.reload(); // the window reads the Trunks and their computers at start
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await act(page, "setgo", { v: "computer" });
  const chip = page.locator(`[data-act="comp-chip"][data-id="${id}"][data-v="this"]`);
  await chip.click({ timeout: 15000 });
  const chipped = await until("the chip saved", async () => { const v = await read(); return JSON.stringify(v.allowed) !== JSON.stringify(before.allowed) && v; });
  check("comp-chip: This computer toggled for the Trunk (GET /api/trunks/<id>/computers)", chipped, JSON.stringify(chipped.allowed));
  await chip.click();
  await until("the chip back on", async () => (await read()).allowed.includes("this"));
  await page.locator(`[data-act="comp-max"][data-id="${id}"][data-v="1"]`).click();
  const max = await until("At once saved", async () => { const v = await read(); return v.atOnce === 1 && v; });
  check("comp-max: At once 1 (GET /api/trunks/<id>/computers)", max, `before: ${before.atOnce}`);
  const chat = (await call("trunks")).trunks.find((x) => x.id === id)?.chatSessionId;
  await act(page, "chat", { id: chat });
  await act(page, "stage", { v: "computer" });
  await page.locator("#stage7 .st7-pick").click({ timeout: 15000 });
  const was = (await read()).allowed.includes("this");
  await page.locator('.pop [data-act="comp-toggle"][data-v="this"]').click();
  check("comp-toggle: the view's computer menu changes what the Trunk may use", await until("the toggle saved", async () => (await read()).allowed.includes("this") !== was));
  await call(`trunks/${id}/computers`, { allowed: before.allowed, atOnce: before.atOnce });
  await page.keyboard.press("Escape");
}

async function main() {
  const pages = await startPages(), llm = await startModel();
  await call("onboarding", { done: true });
  // Opening a website Branch has not visited asks first ("Just do it inside my workspace"); the owner's policy is put back.
  const policy = await call("policy"), workspace = policy.presets.find((x) => x.id === "workspace");
  await call("policy", { ...policy.policy, preset: workspace.id, rules: workspace.rules });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    const sid = await emptyState(page);
    const runId = await openPage(page, sid);
    await dockAndPip(page, runId);
    const going = await follow(page, sid);
    await household(sid);
    // Switching the profile back redraws the window from the start; the conversation and its view are opened again.
    await until("the view open again", async () => {
      if (!(await page.locator("#stage7 .live7-img").count())) { await act(page, "chat", { id: sid }); await sleep(600); await act(page, "stage", { v: "browser" }); await sleep(900); }
      return (await page.locator("#stage7 .live7-img").count()) === 1;
    }, 20000);
    await stop(page, sid, going);
    await computers(page);
  } catch (error) {
    check("ran to the end", false, error.message.split("\n")[0]);
    await shot(page, "failure").catch(() => undefined);
  } finally {
    release();
    check("no page errors", errors.length === 0, errors.join("; "));
    await browser.close();
    await call("policy", { ...policy.policy, confirmLoosening: true }).catch((error) => console.error("could not put the policy back:", error.message));
    pages.close(); llm.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
main();
