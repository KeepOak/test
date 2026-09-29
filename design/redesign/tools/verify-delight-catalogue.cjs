// Verifies the delight catalogue (briefs/DELIGHT-CATALOGUE.md) in the real window against a fresh engine, 1:1 with
// design/redesign/prototype.html (petGallery12 + PETS17, SCENES12 + SCENES17, BRANCH_ANIM / anim11 / cheer11, ART17):
//   1. Every file the catalogue draws answers 200 with its type: 40 picture pets (still + walk), Branch's 11 loops and
//      the stills they fall back to, the 18 painted scenes, the feature pictures.
//   2. Setup's welcome plays Branch's idle loop (a still with reduced motion); its Make it yours draws every pet card and
//      marks New only on pass 17's six scenes and six pets; the empty conversation plays Branch's idle loop too.
//   3. Appearance › The pet: None + 44 pets in the prototype's order, every picture drawn, the three pixel pets drawn
//      on their canvas and stepping (the pixels change frame to frame), New only on pass 17's six, no spinner anywhere.
//   4. Every pet picked is saved by the engine (GET /api/delight) and drawn at the foot of the list: a picture pet as its
//      walk loop, Little Branch as Branch's walk loop, a pixel pet on its canvas, stepping and walking along; a pixel
//      pet is still drawn after a redraw and in the status bar; a pat speaks and the engine counts it.
//   5. A real run (POST /api/run, answered by the stand-in model below): while it runs the pet works (Little Branch's
//      work loop, a walk loop at 1.6x); when it completes the cheer card plays Branch's yay loop with the run's own words,
//      and the pet cheers (yay loop, hop).
//   6. A minute with no click or key: the pet naps (the "z", Little Branch's sleep loop, a walk loop paused, a pixel pet
//      stops stepping and walking); a click wakes it.
//   7. After a reload the pet picked is still picked and drawn.
//   8. Every painted scene picked is the one behind the glass and its picture loads; New only on pass 17's six.
//   9. Feature pictures: all seven in Appearance › Pictures around Branch, their loops paused while scrolled off screen;
//      the cloud one in Settings › Computer's offer;
//      the learn and workbook ones in Customize › Skills. (Timeline's empty state: verify-p17-art.cjs.)
//  10. Achievements: the engine's full list (505), each with its tier's medal.
//  11. Reduced motion: pets, Little Branch, setup and the scene are stills; pixel pets hold still; no loop plays.
// Page errors must be zero. Screenshots go to $SHOTS (default: <temp>/verify-delight-catalogue).
// The stand-in OpenAI-shaped model is served on STUB_PORT: it answers "Hello." after four seconds, so the run is seen
// running. Start a fresh engine pointed at it (a fresh data folder: setup must open by itself), then this script with the
// token the engine printed (the stand-in is up before any run is asked for):
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:33533/v1 BRANCH_MODEL=stand-in BRANCH_API_KEY=local-test \
//   BRANCH_DATA_DIR=<fresh> BRANCH_PORT=3533 node dist/cli.js start
//   STUB_PORT=33533 PORT=3533 TOKEN=<hex> node design/redesign/tools/verify-delight-catalogue.cjs
// It takes about six minutes; three of them are the naps.
const http = require("node:http");
const { chromium } = require("playwright");
const { mkdirSync } = require("node:fs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, STUB_PORT = process.env.STUB_PORT;
if (!PORT || !TOKEN || !STUB_PORT) { console.error("Set PORT, TOKEN and STUB_PORT."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || require("node:path").join(require("node:os").tmpdir(), "verify-delight-catalogue");
mkdirSync(SHOTS, { recursive: true });

/* The stand-in model: every answer after four seconds. */
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
  req.on("end", () => { const body = JSON.parse(raw || "{}"); setTimeout(() => reply(res, body.stream, "Hello."), 4000); });
});

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

/* The prototype's catalogue, last definitions winning. */
const PAINTED = ["mossfrog", "leafhog", "fennec", "otter", "capybara", "cloverbun", "owlet", "shellsnail", "jelly", "cloudsheep", "pebblecrab", "caterpillar",
  "sprigdragon", "turtle", "penguin", "puppy", "kitten", "raccoon", "koala", "sloth", "fruitbat", "bumblebee", "beetle", "duckling", "hamster", "sealpup", "octopus",
  "chameleon", "firefly", "dustbunny", "mossgolem", "narwhal", "squirrel", "elephant"];
const NEW17 = ["redpanda", "pangolin", "quokka", "acornling", "goatkid", "piglet"];
const PIXEL = ["squirrel", "owl", "hedgehog"];
const NEW_SCENES = ["night17-lake", "night17-highland", "day17-sea", "day17-meadow", "glow17-amber", "season17-snow"];
const kindOf = (id) => (id === "squirrel" ? "pet-squirrel" : id);
const PICTURES = [...PAINTED, ...NEW17];
const ORDER = ["none", "sprout", ...PAINTED.map(kindOf), ...NEW17, ...PIXEL];
const ANIMS = ["idle", "oops", "read", "search", "sleep", "talk", "think", "wait", "walk", "work", "yay"];
const SCENES = [["auto", ""], ["spring", "/art/grove-spring.webp"], ["autumn", "/art/grove-autumn.webp"], ["winter", "/art/grove-winter.webp"], ["night", "/art/grove-night.webp"],
  ...["summer", "rain", "lake", "blossom", "canyon", "snownight", "bamboo", "hills"].map((id) => [id, `/art/bg/grove-${id}.webp`]),
  ["night17-lake", "/art/bg/lake-night.webp"], ["night17-highland", "/art/bg/highland-moon.webp"], ["day17-sea", "/art/bg/sea-morning.webp"], ["day17-meadow", "/art/bg/meadow-afternoon.webp"],
  ["glow17-amber", "/art/bg/glow-amber.webp"], ["season17-snow", "/art/bg/first-snow.webp"]];
const ART = [["cloud", false], ["call", false], ["meeting", false], ["learn", false], ["timeline", false], ["branch-call", true], ["branch-workbook", true]];
const FILES = [
  ...PICTURES.flatMap((id) => [`/art/pets/${id}.webp`, `/art/pets/${id}-walk.webm`]),
  ...ANIMS.map((a) => `/art/anim-${a}.webm`), "/art/branch-wave.webp", "/art/branch-yay.webp",
  ...SCENES.filter(([, f]) => f).map(([, f]) => f),
  ...ART.flatMap(([f, still]) => (still ? [`/art/${f}.webp`] : [`/art/${f}.webp`, `/art/${f}.webm`])),
];

async function served() {
  check("the catalogue's files are listed: 80 pet files, 11 loops, 2 stills, 18 scenes, 12 feature pictures", FILES.length === 123, `${FILES.length}`);
  const bad = [];
  for (const f of FILES) {
    const res = await fetch(BASE + f), bytes = (await res.arrayBuffer()).byteLength, type = res.headers.get("content-type");
    if (!(res.status === 200 && bytes > 0 && type === (f.endsWith(".webm") ? "video/webm" : "image/webp"))) bad.push(`${f} ${res.status} ${type} ${bytes}`);
  }
  check(`every one of the ${FILES.length} files answers 200 with its type`, bad.length === 0, bad.join("; "));
}

/* ---------- in the page ---------- */
async function signIn(page) {
  await page.goto(BASE + "/");
  const field = page.getByLabel("Session token");
  await field.waitFor({ timeout: 8000 }).catch(() => {});
  if (await field.isVisible().catch(() => false)) { await field.fill(TOKEN); await page.getByRole("button", { name: "Connect" }).click(); }
  await page.waitForSelector("#side .machine");
  await wait(900);
}
/* Setup has no Skip on its first step; once the engine has onboarding done, a fresh load no longer opens it. */
async function closeSetup(page) {
  if (!(await page.isVisible(".ob9"))) return;
  await api("onboarding", { done: true, skipped: true }); // setup left: a reload mid-setup goes back to it (setup-resume)
  await page.reload();
  await signIn(page);
}
async function settingsPage(page, name, level = "advanced") {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setlevel"][data-v="${level}"]`).first().click().catch(() => {});
  await page.locator(`[data-act="setpage"][data-v="${name}"]`).first().click();
  await wait(700);
}
const appearance = async (page) => { await settingsPage(page, "appearance"); await page.waitForSelector(".pets12"); };
/* A still or a loop as drawn: what it shows and whether it really paints or plays (its time moves on). */
async function drawn(loc, playFor = 600) {
  if (!(await loc.count())) return null;
  return loc.first().evaluate(async (el, ms) => {
    if (el.tagName === "IMG") { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; setTimeout(r, 4000); }); return { tag: "img", src: new URL(el.src).pathname, ok: el.naturalWidth > 0 }; }
    // a loop that preloads nothing may take a moment to start: its time must move on within a few seconds
    let t0 = el.currentTime, playing = false;
    for (let end = Date.now() + Math.max(ms, 4000); !playing && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, ms || 200));
      playing = !el.paused && el.currentTime > t0;
      t0 = el.currentTime;
      if (!ms) break;
    }
    return { tag: "video", src: new URL(el.currentSrc || el.src).pathname, playing, paused: el.paused, rate: el.playbackRate };
  }, playFor);
}
/* A pixel pet's canvas, sampled a few times: how many pixels it paints and how many different frames it showed. */
async function pixels(loc, samples = 5) {
  if (!(await loc.count())) return null;
  return loc.first().evaluate(async (cv, n) => {
    const seen = new Set();
    let opaque = 0;
    for (let i = 0; i < n; i++) {
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let h = 0, op = 0;
      for (let j = 0; j < d.length; j += 4) if (d[j + 3]) { op++; h = (h * 31 + d[j] + d[j + 1] * 7 + d[j + 2] * 13 + j) >>> 0; }
      opaque = Math.max(opaque, op);
      seen.add(h);
      await new Promise((r) => setTimeout(r, 190));
    }
    return { opaque, frames: seen.size };
  }, samples);
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const petbox = (page) => page.locator(".petbox");
/* Where the pet stands along the list, sampled over a second: more than one place means it walks (a turn at the edge
   can bring it back to where it was, so one before-and-after pair is not enough). */
const places = (page) => petbox(page).evaluate(async (b) => { const seen = new Set(); for (let i = 0; i < 7; i++) { seen.add(b.style.transform); await new Promise((r) => setTimeout(r, 170)); } return seen.size; });
const kindNow = async () => (await api("delight")).settings.pets;

async function setupAndEmpty(page, still) {
  await page.waitForSelector(".ob9 .ob-stage11", { timeout: 8000 }).catch(() => {});
  const d = await drawn(page.locator(".ob9 .ob-stage11 video, .ob9 .ob-stage11 img"), 800);
  if (still) check("reduced motion: setup's welcome shows Branch's still", d?.tag === "img" && d.src === "/art/branch-wave.webp" && d.ok, JSON.stringify(d));
  else check("setup's welcome plays Branch's idle loop", d?.tag === "video" && d.src === "/art/anim-idle.webm" && d.playing, JSON.stringify(d));
  await shot(page, still ? "setup-welcome-still" : "setup-welcome");
  if (still) return;
  await closeSetup(page);
  const e = await drawn(page.locator(".empty-chat .hero11 video, .empty-chat .hero11 img"), 800);
  check("the empty conversation plays Branch's idle loop", e?.tag === "video" && e.src === "/art/anim-idle.webm" && e.playing, JSON.stringify(e));
  await shot(page, "empty-conversation");
}

/* (Pass 18c: "Make it yours" is no longer a setup step; it waits on Overview's Finish setting up, which opens
   Settings › Appearance.) */

async function gallery(page) {
  await appearance(page);
  const order = await page.locator(".pets12 .pet-c12").evaluateAll((els) => els.map((b) => b.dataset.v));
  check("the gallery is None and 44 pets in the prototype's order", JSON.stringify(order) === JSON.stringify(ORDER), `${order.length} cards`);
  const cards = page.locator(".pets12 .pet-c12");
  for (let i = 0; i < await cards.count(); i++) await cards.nth(i).scrollIntoViewIfNeeded();
  await wait(1500);
  const pics = await page.locator(".pets12 .pet-c12 img").evaluateAll((els) => els.map((img) => [img.closest("button").dataset.v, new URL(img.src).pathname, img.complete && img.naturalWidth > 0, img.dataset.hov]));
  const wrong = pics.filter(([k, src, ok, hov]) => !ok || (k === "sprout" ? src !== "/art/branch-wave.webp" || hov !== "/art/anim-walk.webm" : src !== `/art/pets/${k === "pet-squirrel" ? "squirrel" : k}.webp` || hov !== src.replace(".webp", "-walk.webm")));
  check("every picture pet and Little Branch is drawn from its still, its walk on hover", pics.length === 41 && wrong.length === 0, `${pics.length} pictures; wrong: ${JSON.stringify(wrong)}`);
  for (const k of PIXEL) {
    const px = await pixels(page.locator(`.pet-c12[data-v="${k}"] canvas`));
    check(`pixel ${k}: drawn on its canvas and stepping`, px && px.opaque > 20 && px.frames >= 2, JSON.stringify(px));
  }
  const news = await page.locator(".pets12 .pet-c12.new17e").evaluateAll((els) => els.map((b) => b.dataset.v));
  check("\"New\" only on pass 17's six pets (the prototype's markNew17)", JSON.stringify(news) === JSON.stringify(NEW17), JSON.stringify(news));
  const spin = await page.locator(".pets12 .spin, .pets12 [aria-busy='true'], .pets12 .pet-px12 svg, .scenes12 .spin").count();
  const noneCard = await page.locator('.pet-c12[data-v="none"] .pet-px12').textContent();
  check("no spinner in the galleries (None is its dash, as the prototype's)", spin === 0 && (await page.locator(".pets12 .pet-px12").count()) === 1 && noneCard === "—", `${spin} spinners`);
  await page.locator('.pet-c12[data-v="otter"]').hover();
  await wait(900);
  const hov = await drawn(page.locator('.pet-c12[data-v="otter"] video'));
  check("hovering a pet plays its walk", hov?.src === "/art/pets/otter-walk.webm" && hov.playing, JSON.stringify(hov));
  await page.mouse.move(2, 2);
  await page.locator(".pets12").scrollIntoViewIfNeeded();
  await shot(page, "appearance-pets");
}

async function everyPet(page) {
  const bad = [];
  for (const kind of ORDER.slice(1)) {
    await page.locator(`.pet-c12[data-v="${kind}"]`).click();
    await wait(650);
    const saved = await kindNow(), pressed = await page.locator(`.pet-c12[data-v="${kind}"]`).getAttribute("aria-pressed");
    let ok = saved.on && saved.kind === kind && pressed === "true", what;
    if (PIXEL.includes(kind)) {
      what = await pixels(page.locator(".petbox canvas#pet-cv"));
      what.moved = (await places(page)) > 1;
      ok = ok && what.opaque > 20 && what.frames >= 2 && what.moved;
    } else {
      what = await drawn(page.locator(".petbox video, .petbox img"), 700);
      const loop = kind === "sprout" ? "/art/anim-walk.webm" : `/art/pets/${kind === "pet-squirrel" ? "squirrel" : kind}-walk.webm`;
      ok = ok && what?.tag === "video" && what.src === loop && what.playing;
    }
    if (!ok) bad.push(`${kind}: ${JSON.stringify(saved)} pressed=${pressed} ${JSON.stringify(what)}`);
    if (["sprout", "otter", "redpanda", "owl"].includes(kind)) await petbox(page).screenshot({ path: `${SHOTS}/pet-${kind}.png` });
  }
  check(`all ${ORDER.length - 1} pets: picked, saved by the engine (GET /api/delight) and walking at the foot of the list`, bad.length === 0, bad.join(" | "));
}

async function pixelRedrawAndStatus(page) {
  await page.locator('.pet-c12[data-v="hedgehog"]').click();
  await wait(600);
  await page.locator('[data-act="ag-size"][data-v="l"]').click(); // a pure layout click that redraws every region
  await wait(500);
  const px = await pixels(page.locator(".petbox canvas#pet-cv"));
  check("a pixel pet is still drawn and stepping after a redraw", px && px.opaque > 20 && px.frames >= 2, JSON.stringify(px));
  await page.locator('[data-act="ag-size"][data-v="m"]').click();
  await page.locator('[data-act="petwhere15"][data-v="status"]').click();
  await wait(700);
  const st = await pixels(page.locator("#statusbar .petbox canvas#pet-cv"));
  check("a pixel pet walks in the status bar too, drawn and stepping", st && st.opaque > 20 && st.frames >= 2, JSON.stringify(st));
  await page.locator("#statusbar").screenshot({ path: `${SHOTS}/pet-statusbar.png` });
  await page.locator('[data-act="petwhere15"][data-v="side"]').click();
  await wait(500);
  const before = (await api("delight/achievements")).list?.find((a) => a.id === "noticed:pats:1")?.got;
  await page.locator(".petbox [data-act='pat']").click();
  await wait(700);
  const words = await page.locator("#pet-say").evaluate((el) => (el.hidden ? "" : el.textContent));
  const after = (await api("delight/achievements")).list?.find((a) => a.id === "noticed:pats:1")?.got;
  check("a pat: the pet speaks, and the engine counts it (Pat pat earned)", words.length > 0 && !before && !!after, `said "${words}", earned before ${before}, after ${after}`);
}

/* A real run through the engine; the window sees it running through the engine's events. */
async function runAndCheer(page, kind) {
  await page.locator(`.pet-c12[data-v="${kind}"]`).click();
  await wait(700);
  const run = api("run", { prompt: `Say hello. ${kind} ${Date.now()}` });
  // the engine's events tell the window the run started; then the pet works until it completes
  const started = await page.waitForFunction((sprout) => { const v = document.querySelector(".petbox video"); return v && (sprout ? new URL(v.currentSrc || v.src).pathname === "/art/anim-work.webm" : v.playbackRate === 1.6); }, kind === "sprout", { timeout: 3500 }).then(() => true, () => false);
  const d = started ? await drawn(page.locator(".petbox video"), 300) : null;
  const working = d && d.playing && (kind === "sprout" ? d.src === "/art/anim-work.webm" : d.rate === 1.6) ? d : null;
  check(kind === "sprout" ? "while a run runs, Little Branch plays Branch's work loop" : `while a run runs, the ${kind}'s walk plays faster (1.6x)`, working, JSON.stringify(working));
  const done = await run;
  await page.waitForSelector(".cheer11", { timeout: 6000 }).catch(() => {});
  const hop = await petbox(page).getAttribute("class");
  const card = await page.locator(".cheer11").evaluate((el) => ({ title: el.querySelector("b")?.textContent, words: el.querySelector("small")?.textContent })).catch(() => null);
  const art = await drawn(page.locator(".cheer11 video, .cheer11 img"), 500);
  check(`the run completed (${done.status}); the cheer card names it done with the run's own words and plays Branch's yay loop`, done.status === "completed" && /is done$/.test(card?.title ?? "") && card?.words === "Hello." && art?.src === "/art/anim-yay.webm" && art.playing,
    `${JSON.stringify(card)} ${JSON.stringify(art)}`);
  const cheer = kind === "sprout" ? await drawn(page.locator(".petbox video"), 300) : null;
  check("the pet cheers with it (hop; Little Branch plays its yay loop)", /hop11/.test(hop) && (kind !== "sprout" || cheer?.src === "/art/anim-yay.webm"), `${hop} ${JSON.stringify(cheer)}`);
  await shot(page, `cheer-${kind}`);
  await wait(4600);
  check("the cheer card goes away by itself, and only one was drawn", (await page.locator(".cheer11").count()) === 0);
}

async function nap(page, kind) {
  await page.locator(`.pet-c12[data-v="${kind}"]`).click();
  await wait(400);
  await page.mouse.move(2, 2);
  await wait(61500); // a minute with no click or key
  const cls = await petbox(page).getAttribute("class");
  let what, ok = /zz11/.test(cls);
  if (kind === "sprout") { what = await drawn(page.locator(".petbox video"), 600); ok = ok && what?.src === "/art/anim-sleep.webm" && what.playing; }
  else if (PIXEL.includes(kind)) {
    what = await pixels(page.locator(".petbox canvas#pet-cv"));
    what.moved = (await places(page)) > 1;
    ok = ok && what.opaque > 20 && what.frames === 1 && !what.moved;
  } else { what = await drawn(page.locator(".petbox video"), 600); ok = ok && what?.paused; }
  check(`a minute idle: the ${kind} naps (${kind === "sprout" ? "sleep loop" : PIXEL.includes(kind) ? "holds still, stops walking" : "its walk paused"}, the "z")`, ok, `${cls} ${JSON.stringify(what)}`);
  await petbox(page).screenshot({ path: `${SHOTS}/nap-${kind}.png` });
  await page.locator(".settings h1").first().click();
  await wait(500);
  check(`a click wakes the ${kind}`, !/zz11/.test(await petbox(page).getAttribute("class")));
}

async function afterReload(page) {
  await page.locator('.pet-c12[data-v="cloverbun"]').click();
  await wait(600);
  await page.reload();
  await signIn(page);
  await appearance(page);
  const saved = await kindNow(), d = await drawn(page.locator(".petbox video, .petbox img"), 700);
  check("after a reload the pet picked is still picked and walking", saved.kind === "cloverbun" && (await page.locator('.pet-c12[data-v="cloverbun"]').getAttribute("aria-pressed")) === "true" && d?.src === "/art/pets/cloverbun-walk.webm" && d.playing,
    `GET /api/delight kind=${saved.kind} ${JSON.stringify(d)}`);
}

async function scenes(page) {
  const bad = [];
  for (const [id, f] of SCENES) {
    const card = page.locator(`.scene-c12[data-v="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await wait(500);
    const bg = await page.locator("#bgLayer .paint11").evaluate(async (el) => {
      const url = /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage)?.[1] ?? "";
      const img = new Image(); img.src = url; await img.decode().catch(() => {});
      return { url: url ? new URL(url, location.href).pathname : "", ok: img.naturalWidth > 0, drift: el.classList.contains("drift11") };
    }).catch(() => null);
    const pressed = await card.getAttribute("aria-pressed");
    const want = f || /^\/art\/grove-(spring|autumn|winter|night)\.webp$/;
    if (!(bg?.ok && pressed === "true" && (typeof want === "string" ? bg.url === want : want.test(bg.url)))) bad.push(`${id}: ${JSON.stringify(bg)} pressed=${pressed}`);
  }
  check(`all ${SCENES.length} painted scenes: picked, behind the glass, their picture loads`, bad.length === 0, bad.join(" | "));
  const news = await page.locator(".scenes12 .scene-c12.new17e").evaluateAll((els) => els.map((b) => b.dataset.v));
  check("\"New\" only on pass 17's six scenes (the prototype's markNew17)", JSON.stringify(news) === JSON.stringify(NEW_SCENES), JSON.stringify(news));
  await page.locator(".scenes12").scrollIntoViewIfNeeded();
  await shot(page, "appearance-scenes");
  await page.locator('.scene-c12[data-v="day17-sea"]').click();
  await wait(500);
  await page.keyboard.press("Escape");
  await wait(500);
  await shot(page, "scene-behind-glass");
}

async function pictures(page) {
  await appearance(page);
  const sec = page.locator(".sec", { has: page.locator("h2", { hasText: "Pictures around Branch" }) });
  const bad = [];
  await sec.scrollIntoViewIfNeeded();
  for (const [f, stillOnly] of ART) {
    const d = await drawn(sec.locator(`[data-art17="art17-${f}"] video, [data-art17="art17-${f}"] img`), 900);
    if (!(stillOnly ? d?.tag === "img" && d.src === `/art/${f}.webp` && d.ok : d?.tag === "video" && d.src === `/art/${f}.webm` && d.playing)) bad.push(`${f}: ${JSON.stringify(d)}`);
  }
  check("Pictures around Branch: all seven, loops playing, Branch's two as stills", (await sec.locator(".art-c17e").count()) === 7 && bad.length === 0, bad.join(" | "));
  // only loops on screen play (the prototype's pass 13a): scrolled away they pause, scrolled back they play again
  const loops = () => sec.locator("video").evaluateAll((vs) => vs.map((v) => !v.paused));
  await page.locator(".settings h1").first().scrollIntoViewIfNeeded();
  await wait(900);
  const away = await loops();
  await sec.scrollIntoViewIfNeeded();
  await wait(1500);
  const back = await loops();
  check("the feature pictures' loops pause off screen and play again on screen", away.length === 5 && away.every((p) => !p) && back.every((p) => p), `off screen playing: ${JSON.stringify(away)}; back: ${JSON.stringify(back)}`);
  await settingsPage(page, "computer");
  const cloud = await drawn(page.locator(".cl-offer17d .spot17e video, .cl-offer17d .spot17e img"), 900);
  check("Settings › Computer: the cloud offer shows the cloud picture in place of its icon", cloud?.tag === "video" && cloud.src === "/art/cloud.webm" && cloud.playing
    && (await page.locator(".cl-offer17d .ico-tile").evaluateAll((els) => els.every((el) => getComputedStyle(el).display === "none"))), JSON.stringify(cloud));
  await page.locator(".cl-offer17d").first().screenshot({ path: `${SHOTS}/art-cloud-offer.png` });
  await page.keyboard.press("Escape");
  // one skill of the owner's own (POST /api/skills/install), so a skill other than learn-this can be picked
  await api("skills/install", { document: "---\nname: tidy-notes\ndescription: Tidies a notes file.\n---\nTidy the notes file.\n" });
  await page.reload();
  await signIn(page);
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="tools"]').first().click();
  await page.locator('[data-act="t9-kind"][data-v="skills"]').first().click();
  await wait(800);
  // learn-this is picked first: its detail shows Branch reading a workbook; any other skill brings the learn card back
  const items = await page.locator(".t9-list .t9-item").evaluateAll((els) => els.map((b) => [b.dataset.v, b.textContent.trim()]));
  const learnId = items.find(([, text]) => text.startsWith("learn-this"))?.[0];
  if (learnId) await page.locator(`.t9-item[data-v="${learnId}"]`).first().click();
  await wait(900);
  const book = await drawn(page.locator(".wb17d .t9-dh .spot17e img, .wb17d .t9-dh .spot17e video"), 0);
  check("Customize › Skills › learn-this: Branch reading a workbook (a still)", book?.tag === "img" && book.src === "/art/branch-workbook.webp" && book.ok, JSON.stringify(book));
  await page.locator(".wb17d .t9-dh").first().screenshot({ path: `${SHOTS}/art-workbook.png` }).catch(() => {});
  const other = items.find(([id]) => id !== learnId)?.[0];
  if (other) await page.locator(`.t9-item[data-v="${other}"]`).first().click();
  await wait(900);
  const learn = await drawn(page.locator(".wb-tile17d .spot17e video, .wb-tile17d .spot17e img"), 900);
  check("Customize › Skills (another skill picked): the learn card shows the learn picture", learn?.tag === "video" && learn.src === "/art/learn.webm" && learn.playing, `${items.length} skills; ${JSON.stringify(learn)}`);
  await page.locator(".wb-tile17d").first().screenshot({ path: `${SHOTS}/art-learn-tile.png` }).catch(() => {});
}

async function achievements(page) {
  await settingsPage(page, "achievements");
  await page.waitForSelector(".achs .ach");
  const view = await api("delight/achievements");
  const cards = await page.locator(".achs .ach").evaluateAll((els) => els.map((a) => { const m = a.querySelector(".medal"); return [m?.style.background || m?.style.backgroundColor || "", !!m?.querySelector("svg")]; }));
  const noMedal = cards.filter(([bg, svg]) => !bg || !svg).length;
  check(`Achievements: the engine's full list (${view.total}) with a medal each`, view.total === 505 && cards.length === 505 && noMedal === 0 && (await page.locator(".ach-sum .tierc").count()) === 6, `${cards.length} cards, ${noMedal} without a medal`);
  await shot(page, "achievements");
}

async function reduced(browser, onboarded) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  if (!onboarded) { await setupAndEmpty(page, true); await ctx.close(); return errors; }
  await closeSetup(page);
  await appearance(page);
  for (const [kind, still] of [["sprout", "/art/branch-wave.webp"], ["otter", "/art/pets/otter.webp"]]) {
    await page.locator(`.pet-c12[data-v="${kind}"]`).click();
    await wait(700);
    const d = await drawn(page.locator(".petbox video, .petbox img"));
    check(`reduced motion: the ${kind} is its still`, d?.tag === "img" && d.src === still && d.ok, JSON.stringify(d));
  }
  await page.locator('.pet-c12[data-v="owl"]').click();
  await wait(700);
  const left0 = await petbox(page).evaluate((b) => b.style.transform);
  const px = await pixels(page.locator(".petbox canvas#pet-cv"), 6), card = await pixels(page.locator('.pet-c12[data-v="owl"] canvas'), 4);
  check("reduced motion: a pixel pet is drawn and holds still (one frame, not walking), in the gallery too", px?.opaque > 20 && px.frames === 1 && card?.opaque > 20 && card.frames === 1 && left0 === await petbox(page).evaluate((b) => b.style.transform), `${JSON.stringify(px)} ${JSON.stringify(card)}`);
  await page.locator('.pet-c12[data-v="goatkid"]').hover();
  await wait(700);
  check("reduced motion: hovering a pet plays nothing", (await page.locator(".pets12 video").count()) === 0);
  await page.locator('.scene-c12[data-v="lake"]').click();
  await wait(500);
  check("reduced motion: the scene is a still (no drift)", (await page.locator("#bgLayer .paint11").getAttribute("class")).split(/\s+/).includes("drift11") === false);
  check("reduced motion: no loop plays on the Appearance page", (await page.locator("video").count()) === 0, `${await page.locator("video").count()} videos`);
  await shot(page, "appearance-reduced-motion");
  await ctx.close();
  return errors;
}

(async () => {
  await new Promise((r) => stub.listen(Number(STUB_PORT), "127.0.0.1", r));
  for (let end = Date.now() + 120000; Date.now() < end;) { if (await api("state").then(() => true, () => false)) break; await wait(500); }
  await served();
  const browser = await chromium.launch();
  const errors = [];
  // setup opens by itself on a fresh engine: first with reduced motion, then as it is
  errors.push(...await reduced(browser, false));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    await setupAndEmpty(page, false);
    await gallery(page);
    await everyPet(page);
    await pixelRedrawAndStatus(page);
    await runAndCheer(page, "sprout");
    await runAndCheer(page, "otter");
    await nap(page, "sprout");
    await nap(page, "owl");
    await nap(page, "otter");
    await afterReload(page);
    await scenes(page);
    await pictures(page);
    await achievements(page);
    errors.push(...await reduced(browser, true));
  } catch (error) {
    check("script ran to the end", false, error.stack);
    await shot(page, "failure").catch(() => {});
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
