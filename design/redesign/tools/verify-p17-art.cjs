// Verifies pass 17's art (design/redesign/pass17/ASSETS17.md) in the real window against a fresh engine: every one of
// the 45 files is served (200, right type, not empty) and is drawn where the prototype draws it, the pet and character
// picks are saved by the engine and read back after a reload, and with reduced motion only stills are drawn.
//   1. Every file answers 200 with its type.
//   2. Timeline pane, empty (a conversation with no task yet): the timeline loop plays in its slot.
//   3. Appearance › The pet: the six new pets are cards with their still (lazy) and walk (on hover). Picking each saves
//      through POST /api/delight/settings (read back with GET /api/delight) and the pet walks along the list as its loop;
//      the loop keeps playing through a redraw (same node, time moving on).
//   4. Appearance › Painted scenes: the six new scenes are marked New; each one picked is the one behind the glass.
//   5. Appearance › Pictures around Branch (Advanced): all seven pictures, their captions, loops playing, stills drawn.
//   6. A Trunk's Look tab: Classic pebble and the three characters; each pick is saved with POST /api/trunks/{id}
//      (read back with GET /api/trunks) and drawn as its avatar; hovering one plays its idle loop.
//   7. The agent beside its conversation acts out real states: idle, then think/work while a message is answered, then
//      the celebration, from the engine's runs; pausing the Trunk (POST /api/trunks/{id}/pause) makes it rest.
//   8. After a reload, the pet and the character are still the ones picked.
//   9. Reduced motion: no <video> anywhere these are drawn; every place shows the still instead.
// Page errors must be zero. Screenshots go to C:/Users/bishi/AppData/Local/Temp/claude-session-files/p17-art/.
// So the Trunk is seen working (not only thinking and done), the engine talks to a stand-in OpenAI-shaped model this
// script serves on STUB_PORT: it answers at once, except a message holding SLOW17, which it answers after five seconds.
// Start the script first (it waits for the engine), then a fresh engine pointed at the stand-in:
//   STUB_PORT=33847 PORT=3247 TOKEN=<hex> node design/redesign/tools/verify-p17-art.cjs
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:33847/v1 BRANCH_MODEL=stand-in BRANCH_API_KEY=local-test \
//   BRANCH_DATA_DIR=<fresh> BRANCH_PORT=3247 node dist/cli.js start
const http = require("node:http");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdirSync } = require("node:fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, STUB_PORT = process.env.STUB_PORT;
if (!PORT || !TOKEN || !STUB_PORT) { console.error("Set PORT, TOKEN and STUB_PORT."); process.exit(2); }

/* The stand-in model. */
function reply(res, stream, text) {
  if (res.writableEnded || res.destroyed) return;
  if (!stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}"), last = JSON.stringify((body.messages ?? []).filter((m) => m.role === "user").at(-1) ?? "");
    if (last.includes("SLOW17")) setTimeout(() => reply(res, body.stream, "Hello."), 5000);
    else reply(res, body.stream, "Done.");
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/p17-art";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const PETS = [["redpanda", "Red panda"], ["pangolin", "Pangolin"], ["quokka", "Quokka"], ["acornling", "Acorn sprite"], ["goatkid", "Goat kid"], ["piglet", "Teacup piglet"]];
const LOOKS = [["sorrel", "Sorrel"], ["skein", "Skein"], ["nib", "Nib"]];
const SCENES = [["night17-lake", "lake-night"], ["night17-highland", "highland-moon"], ["day17-sea", "sea-morning"], ["day17-meadow", "meadow-afternoon"], ["glow17-amber", "glow-amber"], ["season17-snow", "first-snow"]];
const ART = [["art17-cloud", "A cloud computer at work", "cloud"], ["art17-call", "A phone call in progress", "call"], ["art17-meeting", "Joining a meeting", "meeting"], ["art17-learn", "Learning an app", "learn"],
  ["art17-timeline", "A timeline replaying", "timeline"], ["art17-branch-call", "Branch on a call", "branch-call", true], ["art17-branch-workbook", "Branch reading a workbook", "branch-workbook", true]];
const FILES = [
  ...SCENES.map(([, f]) => `/art/bg/${f}.webp`),
  ...PETS.flatMap(([id]) => [`/art/pets/${id}.webp`, `/art/pets/${id}-walk.webm`]),
  ...LOOKS.flatMap(([id]) => ["still.webp", "idle.webm", "think.webm", "work.webm", "yay.webm"].map((f) => `/art/agents/${id}/${f}`)),
  ...ART.flatMap(([, , f, still]) => (still ? [`/art/${f}.webp`] : [`/art/${f}.webp`, `/art/${f}.webm`])),
];

async function served() {
  check("45 pass-17 files are listed", FILES.length === 45, `${FILES.length}`);
  for (const f of FILES) {
    const res = await fetch(BASE + f), bytes = (await res.arrayBuffer()).byteLength, type = res.headers.get("content-type");
    check(`served ${f}`, res.status === 200 && bytes > 0 && type === (f.endsWith(".webm") ? "video/webm" : "image/webp"), `${res.status} ${type} ${bytes} bytes`);
  }
}

/* ---------- in the page ---------- */
async function signIn(page) {
  await page.goto(BASE + "/");
  const field = page.getByLabel("Session token");
  if (await field.isVisible().catch(() => false)) { await field.fill(TOKEN); await page.getByRole("button", { name: "Connect" }).click(); }
  await page.waitForSelector("#side .machine");
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
  await wait(600);
}
async function appearance(page, level = "advanced") {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setlevel"][data-v="${level}"]`).first().click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.waitForSelector(".pets12");
  await wait(500);
}
/* A still or a loop, as drawn: what it is, what it shows, and whether it has really painted. */
async function drawn(loc, playFor = 0) {
  if (!(await loc.count())) return null;
  await loc.first().scrollIntoViewIfNeeded();
  if (playFor) await wait(playFor);
  return loc.first().evaluate(async (el) => {
    if (el.tagName === "IMG" && !el.complete) await new Promise((r) => { el.onload = el.onerror = r; setTimeout(r, 4000); });
    return el.tagName === "VIDEO"
      ? { tag: "video", src: new URL(el.currentSrc || el.src).pathname, preload: el.getAttribute("preload") ?? el.preload, playing: !el.paused && el.currentTime > 0, ready: el.readyState, w: el.videoWidth }
      : { tag: "img", src: new URL(el.src).pathname, lazy: el.loading, ok: el.naturalWidth > 0, w: el.naturalWidth };
  });
}
const media = (sel) => `${sel} video, ${sel} img`;
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

/* A room's conversation before anyone has said anything: it has no task yet, so the Timeline pane is empty. */
const openChat = async (page, sessionId) => { await page.locator(`#side .row[data-id="${sessionId}"]`).first().click(); await wait(800); };
async function timeline(page, room, still) {
  await openChat(page, room.sessionId);
  await page.locator('[data-act="pane"][data-p="activity"]').first().click();
  await page.locator('[data-act="ptabp"][data-p="tl17c"]').click();
  await page.waitForSelector('.pane-b [data-art17="art17-timeline"]');
  const d = await drawn(page.locator(media('.pane-b [data-art17="art17-timeline"]')), still ? 0 : 1500);
  if (still) check("reduced motion: Timeline's empty state shows the still", d?.tag === "img" && d.src === "/art/timeline.webp" && d.ok && d.lazy === "lazy", JSON.stringify(d));
  else check("Timeline's empty state plays the timeline loop", d?.tag === "video" && d.src === "/art/timeline.webm" && d.playing && d.preload === "none", JSON.stringify(d));
  await shot(page, still ? "timeline-empty-still" : "timeline-empty");
  await page.locator('[data-act="pane"][data-p="close"]').click();
}

async function pets(page) {
  await appearance(page);
  for (const [id, name] of PETS) {
    const card = page.locator(`.pet-c12[data-v="${id}"]`);
    const d = await drawn(card.locator("img"));
    check(`pet card ${id}: still, lazy, New`, (await card.innerText()).includes(name) && d?.src === `/art/pets/${id}.webp` && d.ok && d.lazy === "lazy" && (await card.getAttribute("class")).includes("new17e")
      && (await card.locator("img").getAttribute("data-hov")) === `/art/pets/${id}-walk.webm`, JSON.stringify(d));
  }
  await page.locator('.pet-c12[data-v="quokka"]').hover();
  await wait(800);
  const hov = await drawn(page.locator(".pet-c12[data-v=quokka] video"));
  check("hovering a pet plays its walk", hov?.src === "/art/pets/quokka-walk.webm" && hov.playing, JSON.stringify(hov));
  await shot(page, "appearance-pets");
  await page.mouse.move(2, 2);
  for (const [id] of PETS) {
    await page.locator(`.pet-c12[data-v="${id}"]`).click();
    await wait(700);
    const saved = (await api("delight")).settings.pets;
    const walker = await drawn(page.locator(media(".petbox")), 1200);
    check(`pick ${id}: saved by the engine and walking as its loop`, saved.on && saved.kind === id && (await page.locator(`.pet-c12[data-v="${id}"]`).getAttribute("aria-pressed")) === "true"
      && walker?.tag === "video" && walker.src === `/art/pets/${id}-walk.webm` && walker.playing && walker.preload === "none", `GET /api/delight pets=${JSON.stringify(saved)} walker=${JSON.stringify(walker)}`);
    await page.locator(".petbox").screenshot({ path: `${SHOTS}/pet-walking-${id}.png` });
  }
  // the walker keeps its node and keeps playing through a redraw (a pure layout click that redraws everything)
  const before = await page.locator(".petbox video").evaluate((v) => { v.__keep17 = 1; v.__loads17 = 0; v.addEventListener("loadstart", () => v.__loads17++); return v.currentTime; });
  await page.locator('[data-act="ag-size"][data-v="l"]').click();
  await wait(900);
  const after = await page.locator(".petbox video").evaluate((v) => ({ same: v.__keep17 === 1, loads: v.__loads17, t: v.currentTime, paused: v.paused }));
  check("a redraw keeps the walking loop playing (same node, not loaded again, time moved on)", after.same && after.loads === 0 && !after.paused && after.t !== before, `before ${before.toFixed(2)}s, after ${JSON.stringify(after)}`);
  await page.locator('[data-act="ag-size"][data-v="m"]').click();
}

async function scenes(page) {
  for (const [id, f] of SCENES) {
    const card = page.locator(`.scene-c12[data-v="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await wait(700);
    const bg = await page.locator("#bgLayer .paint11").evaluate((el) => el.style.backgroundImage).catch(() => "");
    check(`scene ${id}: marked New and behind the glass`, (await card.getAttribute("class")).includes("new17e") && bg.includes(`/art/bg/${f}.webp`), bg);
  }
  await page.locator(".scenes12").scrollIntoViewIfNeeded();
  await shot(page, "appearance-scenes");
}

async function pictures(page, still) {
  const sec = page.locator(".sec", { has: page.locator("h2", { hasText: "Pictures around Branch" }) });
  check(`Pictures around Branch is in Appearance at Advanced${still ? " (reduced motion)" : ""}`, (await sec.count()) === 1 && (await sec.locator(".art-c17e").count()) === 7);
  for (const [id, label, f, stillOnly] of ART) {
    const fig = sec.locator(".art-c17e", { has: page.locator(`[data-art17="${id}"]`) });
    const d = await drawn(fig.locator("video, img"), still || stillOnly ? 0 : 1500);
    const cap = await fig.locator("figcaption").innerText();
    const ok = still || stillOnly ? d?.tag === "img" && d.src === `/art/${f}.webp` && d.ok && d.lazy === "lazy" : d?.tag === "video" && d.src === `/art/${f}.webm` && d.playing && d.preload === "none";
    check(`picture ${id}${still ? " (reduced motion)" : ""}: ${still || stillOnly ? "still" : "loop"} drawn, caption`, ok && cap === label, JSON.stringify(d));
  }
  await sec.scrollIntoViewIfNeeded();
  await shot(page, still ? "appearance-pictures-still" : "appearance-pictures");
}

async function openEditor(page, trunk) {
  await page.keyboard.press("Escape");
  await page.locator('[data-act="view"][data-v="customize"]').first().click();
  await page.locator(`[data-act="edit"][data-id="${trunk.id}"]`).click();
  await page.waitForSelector(".looks12");
  await wait(400);
}
async function characters(page, trunk) {
  await openEditor(page, trunk);
  const sec = page.locator(".dlg .sec", { has: page.locator("h2", { hasText: "How it looks" }) });
  // Trunk look: every character in the engine's catalogue (GET /api/trunks characters) follows the classic pebble.
  const catalogue = (await api("trunks")).characters ?? [];
  check("the Look tab starts with How it looks: Classic pebble and every character", (await sec.count()) === 1 && (await sec.locator(".look-c12").count()) === 1 + catalogue.length
    && (await sec.locator(".look-c12").first().innerText()).includes("Classic pebble"));
  await sec.locator('.look-c12[data-v="skein"]').hover();
  await wait(800);
  const hov = await drawn(sec.locator('.look-c12[data-v="skein"] video'));
  check("hovering a character plays its idle loop", hov?.src === "/art/agents/skein/idle.webm" && hov.playing, JSON.stringify(hov));
  await page.mouse.move(2, 2);
  for (const [id, name] of LOOKS) {
    const d = await drawn(sec.locator(`.look-c12[data-v="${id}"] img`));
    check(`character card ${id}: still, lazy, New`, d?.src === `/art/agents/${id}/still.webp` && d.ok && d.lazy === "lazy" && (await sec.locator(`.look-c12[data-v="${id}"]`).innerText()).includes(name), JSON.stringify(d));
    await page.locator(`.dlg .look-c12[data-v="${id}"]`).click();
    await wait(900);
    const saved = (await api("trunks")).trunks.find((t) => t.id === trunk.id)?.character;
    const big = await drawn(page.locator(".dlg .editor .big .av img"));
    check(`pick ${id}: saved by the engine and drawn as the avatar`, saved === id && (await page.locator(`.dlg .look-c12[data-v="${id}"]`).getAttribute("aria-pressed")) === "true" && big?.src === `/art/agents/${id}/still.webp` && big.ok,
      `GET /api/trunks character=${saved} avatar=${JSON.stringify(big)}`);
  }
  await shot(page, "trunk-look-tab");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  const row = await drawn(page.locator(`.prow:has([data-id="${trunk.id}"]) .av img`));
  check("Customize › Trunks draws the Trunk as its character", row?.src === "/art/agents/nib/still.webp" && row.ok, JSON.stringify(row));
}

/* In a room, every member that wears a character stands beside the conversation. */
async function roomAgents(page, room) {
  await openChat(page, room.sessionId);
  await page.waitForSelector(".agent12");
  await wait(1200);
  const figs = await page.locator(".agent12 .ag-one12").evaluateAll((els) => els.map((el) => ({ st: el.dataset.st, src: new URL((el.querySelector("video, img").currentSrc || el.querySelector("video, img").src)).pathname })));
  const srcs = figs.map((f) => f.src).sort();
  check("a room shows each member's character beside the conversation", figs.length === 2 && srcs[0] === "/art/agents/nib/idle.webm" && srcs[1] === "/art/agents/sorrel/idle.webm", JSON.stringify(figs));
  await shot(page, "agent-beside-room");
}

async function agent(page, trunk, still) {
  await page.goto(BASE + "/");
  await signIn(page);
  await openChat(page, trunk.chatSessionId);
  await page.waitForSelector(".agent12");
  await wait(1500);
  const one = page.locator(".agent12 .ag-one12");
  const st = async () => ({ st: await one.getAttribute("data-st"), label: await one.locator("small").innerText(), fig: await drawn(one.locator("video, img")) });
  const idle = await st();
  if (still) { check("reduced motion: the agent beside the conversation is its still", idle.fig?.tag === "img" && idle.fig.src === `/art/agents/${trunk.character}/still.webp` && idle.fig.ok, JSON.stringify(idle)); await shot(page, "agent-beside-still"); return; }
  check("the agent beside the conversation plays its idle loop", idle.st === "idle" && idle.label === "Here" && idle.fig?.tag === "video" && idle.fig.src === `/art/agents/${trunk.character}/idle.webm` && idle.fig.playing, JSON.stringify(idle));
  await shot(page, "agent-beside-idle");
  // a message: the states come from this window sending and from the engine's run for this conversation
  const seen = new Map();
  await page.locator("#prompt").fill("Say hello in one line. SLOW17");
  await page.locator("#prompt").press("Enter");
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const s = await one.getAttribute("data-st").catch(() => null);
    if (s && !seen.has(s)) { seen.set(s, await one.locator("video, img").first().evaluate((el) => new URL(el.currentSrc || el.src).pathname).catch(() => "")); if (s === "yay") await shot(page, "agent-beside-yay"); if (s === "work" || s === "think") await shot(page, `agent-beside-${s}`); }
    if (seen.has("yay") && s === "idle") break;
    await wait(80);
  }
  const list = [...seen.entries()].map(([s, src]) => `${s}:${src}`).join(", ");
  check("while this window sends, it thinks (think loop)", seen.get("think") === `/art/agents/${trunk.character}/think.webm`, list);
  check("while the engine's run for its conversation runs, it works (work loop)", seen.get("work") === `/art/agents/${trunk.character}/work.webm`, list);
  check("when the answer lands it celebrates (yay loop), then goes back to idle", seen.get("yay") === `/art/agents/${trunk.character}/yay.webm` && seen.has("idle"), list);
  await api(`trunks/${trunk.id}/pause`, {});
  await page.reload(); await signIn(page);
  await openChat(page, trunk.chatSessionId);
  await page.waitForSelector(".agent12");
  const rest = await st();
  check("a paused Trunk rests (label Resting, idle loop as the fallback)", rest.st === "sleep" && rest.label === "Resting" && rest.fig?.src === `/art/agents/${trunk.character}/idle.webm`, JSON.stringify(rest));
  await api(`trunks/${trunk.id}/resume`, {});
}

/* Overview › Now: a task running in the Trunk's own conversation shows its character at work. */
async function overview(page, trunk) {
  const said = api(`trunks/${trunk.id}/say`, { text: `SLOW17 ${Date.now()}` }).catch((error) => ({ error: error.message }));
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  let d = null;
  for (let end = Date.now() + 6000; Date.now() < end && !d?.playing; await wait(200)) d = await drawn(page.locator(".tile .live-fig12 video"), 0);
  await wait(600);
  d = await drawn(page.locator(".tile .live-fig12 video, .tile .live-fig12 img"));
  check("Overview › Now shows the running Trunk's character at work (work loop)", d?.tag === "video" && d.src === `/art/agents/${trunk.character}/work.webm` && d.playing, JSON.stringify(d));
  await shot(page, "overview-now-working");
  await said;
}

async function afterReload(page, trunk) {
  await page.reload();
  await signIn(page);
  await appearance(page);
  const saved = (await api("delight")).settings.pets.kind;
  check("after a reload the pet picked is still picked and walking", (await page.locator(`.pet-c12[data-v="${saved}"]`).getAttribute("aria-pressed")) === "true" && saved === "piglet"
    && (await drawn(page.locator(media(".petbox"))))?.src === "/art/pets/piglet-walk.webm", `GET /api/delight kind=${saved}`);
  await openEditor(page, trunk);
  check("after a reload the character picked is still picked", (await page.locator('.dlg .look-c12[data-v="nib"]').getAttribute("aria-pressed")) === "true"
    && (await drawn(page.locator(".dlg .editor .big .av img")))?.src === "/art/agents/nib/still.webp");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function reduced(browser, trunk, room) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await appearance(page);
  const walker = await drawn(page.locator(media(".petbox")));
  check("reduced motion: the pet is its still", walker?.tag === "img" && walker.src === "/art/pets/piglet.webp" && walker.ok, JSON.stringify(walker));
  await page.locator('.pet-c12[data-v="goatkid"]').hover();
  await wait(700);
  check("reduced motion: hovering a pet plays nothing", (await page.locator(".pet-c12 video").count()) === 0);
  await pictures(page, true);
  check("reduced motion: no video on the Appearance page", (await page.locator("video").count()) === 0, `${await page.locator("video").count()} videos`);
  await shot(page, "appearance-still");
  await openEditor(page, trunk);
  await page.locator('.dlg .look-c12[data-v="sorrel"]').hover();
  await wait(700);
  check("reduced motion: hovering a character plays nothing", (await page.locator(".dlg video").count()) === 0);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await agent(page, trunk, true);
  check("reduced motion: no video beside the conversation", (await page.locator("video").count()) === 0);
  await timeline(page, room, true);
  check("reduced motion: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

(async () => {
  await new Promise((r) => stub.listen(Number(STUB_PORT), "127.0.0.1", r));
  for (let end = Date.now() + 120000; Date.now() < end;) { if (await api("state").then(() => true, () => false)) break; await wait(500); }
  await served();
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(), errors = [], art = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (new URL(r.url()).pathname.startsWith("/art/")) art.push([new URL(r.url()).pathname, r.status()]); });
  try {
    // two Trunks and a room of both; the room's conversation has no task yet (a Trunk's own opens with its introduction)
    await api("trunks/switch", { part: "trunks", mode: "on" });
    await api("trunks/switch", { part: "rooms", mode: "on" });
    const RUN = Date.now().toString(36).slice(-4);
    const made = (await api("trunks", { name: `Art check ${RUN}` })).trunk, other = (await api("trunks", { name: `Art pair ${RUN}` })).trunk;
    const room = (await api("trunks/rooms", { name: `Art room ${RUN}`, members: [made.id, other.id] })).room;
    await signIn(page);
    await timeline(page, room, false);
    await pets(page);
    await scenes(page);
    await pictures(page, false);
    await characters(page, made);
    await openEditor(page, other);
    await page.locator('.dlg .look-c12[data-v="sorrel"]').click();
    await wait(900);
    await page.locator('.dlg [data-act="dlg-close"]').first().click();
    const trunk = (await api("trunks")).trunks.find((t) => t.id === made.id);
    await roomAgents(page, room);
    await agent(page, trunk, false);
    await overview(page, trunk);
    await afterReload(page, trunk);
    const bad = art.filter(([, s]) => s !== 200 && s !== 206);
    check("every /art request the window made answered 200 (or 206 for a range)", art.length > 0 && bad.length === 0, `${art.length} requests; bad: ${JSON.stringify(bad)}`);
    check("no page errors", errors.length === 0, errors.join(" | "));
    await reduced(browser, trunk, room);
  } catch (error) {
    check("script ran to the end", false, error.stack);
    await shot(page, "failure").catch(() => {});
  }
  await browser.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
