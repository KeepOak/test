/* your-profile: proves Your profile in the real window against a FRESH engine, reading every change back through the
   engine's own GET routes (GET /api/profiles, /api/profiles/owner/about, /api/profiles/owner/picture, /api/look).
   Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-your-profile.cjs
   Test data it makes through the engine: a household person "Amara" (PIN 4321). Screenshots go to SHOTS (default
   %TEMP%/claude-session-files/your-profile). Nothing launches a desktop window. */
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const SHOTS = process.env.SHOTS || join(process.env.TEMP || ".", "claude-session-files", "your-profile");
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error ?? String(r.status));
  return data;
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const greyedIn = (page, root) => page.locator(`${root} [data-act], ${root} input, ${root} select`).evaluateAll((nodes) =>
  nodes.filter((n) => n.getAttribute("aria-disabled") === "true" || n.classList.contains("soon") || n.disabled).map((n) => n.dataset.act || n.id || n.outerHTML.slice(0, 60)));

async function signIn(browser) {
  await api("onboarding", { done: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  return { page, errors };
}
async function openMine(page) {
  await page.locator('#side [data-act="owner"]').click();
  await page.locator('.pop [data-act="yp-open"]').click();
  await page.locator("#yp").waitFor();
}

/* 1: your own tile opens Your profile; everybody else's still switches. Nothing in it is greyed. */
async function opens(page) {
  await page.locator('#side [data-act="owner"]').click();
  const mine = page.locator('.pop [data-act="yp-open"]'), others = page.locator('.pop [data-act="switchto"]');
  check("the person menu: your own tile is live and opens Your profile", (await mine.count()) === 1 && (await mine.getAttribute("aria-disabled")) !== "true");
  check("the person menu: Amara's tile still switches (switchto)", (await others.count()) === 1 && /Amara/.test(await others.innerText()));
  await shot(page, "01-person-menu");
  await mine.click();
  await page.locator("#yp").waitFor();
  check("clicking your own tile opens Your profile", await page.locator('.dlg[aria-label="Your profile"]').isVisible());
  const greyed = await greyedIn(page, ".dlg");
  check("nothing in Your profile is greyed or dead", greyed.length === 0, greyed.join(", "));
  await shot(page, "02-your-profile-owner");
}

/* 2: name, picture, time zone and language save through the engine. */
async function saves(page) {
  await page.locator("#yp-name").fill("Robin");
  await page.locator("#yp-name").press("Enter");
  check("name: saved (GET /api/profiles owner.name)", await until(async () => (await api("profiles")).owner.name === "Robin"));
  check("name: the sidebar's owner row says it at once", await until(async () => (await page.locator('#side [data-act="owner"] .who14 b').innerText()) === "Robin"));
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 96, height: 96 } });
  await page.locator("#yp-file").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
  const photo = await until(async () => { const a = (await api("profiles")).owner.avatar; return a.face === "photo" && a.picture ? a : null; });
  check("picture: uploaded through the engine (GET /api/profiles owner.avatar.face = photo)", !!photo);
  const pic = (await api("profiles/owner/picture")).picture ?? "";
  check("picture: the engine keeps it, made small and square (GET /api/profiles/owner/picture)", /^data:image\/png;base64,/.test(pic) && pic.length < 200000, `${pic.length} chars`);
  check("picture: the preview and the sidebar show it", await until(async () => (await page.locator("#yp .photo-yp img").count()) === 1 && (await page.locator("#side .owner .photo-yp img").count()) === 1));
  await shot(page, "03-photo");
  await page.locator('#yp [data-act="yp-face"][data-v="initial"]').click();
  await page.locator('#yp [data-act="yp-colour"]').nth(2).click();
  const initial = await until(async () => { const a = (await api("profiles")).owner.avatar; return a.face === "initial" && a.color ? a : null; });
  check("initial with colour: saved (GET /api/profiles)", initial?.color === "#8a5aa8", JSON.stringify(initial));
  await page.locator('#yp [data-act="yp-face"][data-v="emoji"]').click();
  await page.locator('#yp [data-act="yp-emoji"][data-v="🦊"]').click();
  check("emoji: saved (GET /api/profiles)", await until(async () => (await api("profiles")).owner.avatar.emoji === "🦊"));
  check("emoji: the sidebar shows it", await until(async () => (await page.locator("#side .owner .emoji-yp").innerText()) === "🦊"));
  await shot(page, "04-emoji");
  await page.locator('#yp [data-act="yp-face"][data-v="photo"]').click();
  check("photo again: saved (GET /api/profiles)", await until(async () => (await api("profiles")).owner.avatar.face === "photo"));
  await page.locator("#yp-tz").selectOption("Asia/Tokyo");
  check("time zone: saved (GET /api/profiles/owner/about)", await until(async () => (await api("profiles/owner/about")).timezone === "Asia/Tokyo"));
  const proposed = await api("schedules/propose", { edit: { prompt: "Water the plants", dailyAt: "08:00" } });
  check("time zone: schedules are proposed in it (POST /api/schedules/propose)", proposed.proposal.schedule.timezone === "Asia/Tokyo");
  await page.locator("#yp-lang").selectOption("fr");
  check("language: saved (GET /api/look language = fr)", await until(async () => (await api("look")).language === "fr"));
  check("language: Your profile is in French at once", await until(async () => (await page.locator(".dlg .dlg-h h2").innerText()) === "Votre profil"));
  await shot(page, "05-french");
  await page.locator("#yp-lang").selectOption("en");
  check("language: back to English (GET /api/look)", await until(async () => (await api("look")).language === "en"));
}

/* 3: the links go where they say, and App lock is the real row. */
async function links(page) {
  check("App lock: the real row, live", (await page.locator('#yp [data-act="applockb17"]').count()) === 3 && (await greyedIn(page, "#yp")).length === 0);
  await page.locator('#yp [data-act="yp-go"][data-v="signin"]').click();
  check("the PIN for switching back: opens Team › Signing in", await until(async () => (await page.locator("#yp").count()) === 0 && (await page.locator('#main .tab[aria-selected="true"]').innerText()).includes("Signing in")));
  await openMine(page);
  await page.locator('#yp [data-act="yp-go"][data-v="accounts"]').click();
  check("connected accounts: opens Settings › Accounts", await until(async () => (await page.locator("#yp").count()) === 0 && /Accounts/.test(await page.locator("#main h1").first().innerText())));
}

/* 4: after a reload, every tile shows the picture and the name. */
async function everywhere(page) {
  await page.reload();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  check("after a reload: the sidebar shows Robin and the photo", await until(async () => (await page.locator('#side [data-act="owner"] .who14 b').innerText()) === "Robin" && (await page.locator("#side .owner .photo-yp img").count()) === 1));
  await page.locator('#side [data-act="owner"]').click();
  check("after a reload: the person menu's tile shows Robin and the photo", await until(async () => /Robin/.test(await page.locator('.pop [data-act="yp-open"]').innerText()) && (await page.locator('.pop [data-act="yp-open"] img').count()) === 1));
  await page.keyboard.press("Escape");
  await page.locator('#side .nav[data-v="overview"]').click();
  check("Overview: Who is using Branch shows Robin with the photo", await until(async () => (await page.locator("#main .tile .photo-yp img").count()) >= 1 && /Robin/.test(await page.locator("#main").innerText())));
  await page.locator('#side .nav[data-v="automations"]').click();
  await page.locator("#nl-in").fill("every day at 08:00 water the plants");
  const asked = page.waitForResponse((r) => r.url().includes("/api/schedules/propose") && r.request().method() === "POST");
  await page.locator('[data-act="nl-add"]').click();
  const answer = await asked, sent = JSON.parse(answer.request().postData() ?? "{}"), got = await answer.json();
  check("Automations: the window proposes a schedule in your time zone (POST /api/schedules/propose)", sent.timezone === "Asia/Tokyo", sent.timezone);
  check("Automations: the engine's proposal is in it", got.proposal?.schedule?.timezone === "Asia/Tokyo" && /Asia\/Tokyo/.test(got.proposal?.words ?? ""), got.proposal?.words);
  await page.locator('[data-act="ppno17d"]').waitFor();
  await page.locator('[data-act="ppno17d"]').click();
  await page.locator('#side .nav[data-v="team"]').click();
  await page.locator('#main .tab[data-v="people"], #main [data-act="ptab"][data-v="people"]').first().click();
  check("Team › People: Robin, with the photo", await until(async () => (await page.locator("#main .t9-item .photo-yp img").count()) >= 1 && /Robin/.test(await page.locator("#main .t9-list").innerText())));
  await page.waitForTimeout(700); // the place eases in
  await shot(page, "06-team-people");
  await page.locator('[data-act="guide"]').first().click();
  await page.locator('.pop [data-act="onboard"]').click();
  await page.locator(".ob-agree").click();
  await page.locator('[data-act="ob-go"][data-v="8"]').click();
  check("setup's People step: asks the name, and has Robin", await until(async () => (await page.locator("#ob-name").inputValue()) === "Robin"));
  await page.locator("#ob-name").fill("Robin Hood");
  await page.locator("#ob-name").press("Enter");
  check("setup's People step: a new name is saved (GET /api/profiles)", await until(async () => (await api("profiles")).owner.name === "Robin Hood"));
  check("setup's People step: nothing greyed on the name field", !(await page.locator("#ob-name").isDisabled()));
  await shot(page, "07-setup-people");
  await page.locator('[data-act="ob-close"]').first().click();
}

/* 5: a household person edits only their own profile. */
async function household(page, amara) {
  await page.locator('#side [data-act="owner"]').click();
  await page.locator('.pop [data-act="switchto"]').filter({ hasText: "Amara" }).click();
  await page.locator("#pin-try").fill("4321");
  const reloaded = page.waitForEvent("load", { timeout: 8000 }).catch(() => null); // the window starts again as the new person (main.js watchPerson)
  await page.locator('[data-act="pin-ok"]').click();
  check("switched to Amara through the PIN (GET /api/profiles active)", await until(async () => (await api("profiles")).active?.id === amara.id));
  await reloaded;
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await until(async () => (await page.locator('#side [data-act="owner"] .who14 b').innerText()) === "Amara");
  await page.locator('#side [data-act="owner"]').click();
  check("as Amara: the owner's tile switches back, Amara's opens her profile",
    /Robin Hood/.test(await page.locator('.pop [data-act="switchto"]').innerText()) && /Amara/.test(await page.locator('.pop [data-act="yp-open"]').innerText()));
  await page.locator('.pop [data-act="yp-open"]').click();
  await page.locator("#yp").waitFor();
  check("as Amara: only her own name and picture (no language, time zone, App lock or accounts)",
    (await page.locator("#yp-lang, #yp-tz, #yp [data-act='applockb17'], #yp [data-act='yp-go']").count()) === 0 && (await page.locator("#yp-name").inputValue()) === "Amara");
  const greyed = await greyedIn(page, ".dlg");
  check("as Amara: nothing in her profile is greyed or dead", greyed.length === 0, greyed.join(", "));
  await shot(page, "08-your-profile-household");
  await page.locator("#yp-name").fill("Amara K");
  await page.locator("#yp-name").press("Enter");
  await page.locator('#yp [data-act="yp-face"][data-v="emoji"]').click();
  await page.locator('#yp [data-act="yp-emoji"][data-v="🌻"]').click();
  const list = await until(async () => { const l = await api("profiles"); const me = l.profiles.find((p) => p.id === amara.id); return me.name === "Amara K" && me.avatar.emoji === "🌻" ? l : null; });
  check("as Amara: her name and emoji are saved (GET /api/profiles)", !!list);
  check("as Amara: the owner's profile is untouched (GET /api/profiles owner)", list?.owner.name === "Robin Hood" && list?.owner.avatar.face === "photo");
  const refused = await api("profiles/owner/about", { name: "Mallory" }).then(() => "", (e) => e.message);
  check("as Amara: the engine refuses her the owner's profile", /belongs to the owner/.test(refused), refused);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator('#side [data-act="owner"]').click();
  await page.locator('.pop [data-act="switchto"]').click();
  check("back to the owner (GET /api/profiles isOwner)", await until(async () => (await api("profiles")).isOwner === true));
}

(async () => {
  const amara = (await api("profiles")).profiles.find((p) => p.name.startsWith("Amara")) ?? await api("profiles", { name: "Amara", pin: "4321" });
  const browser = await chromium.launch({ headless: true });
  const { page, errors } = await signIn(browser);
  try {
    await opens(page);
    await saves(page);
    await links(page);
    await everywhere(page);
    await household(page, amara);
  } catch (error) {
    check(`the run finished without a thrown error`, false, error.message.split("\n")[0]);
    await shot(page, "zz-failure").catch(() => {});
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
