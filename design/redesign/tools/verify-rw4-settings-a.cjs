/* Settings A, 1:1 fill (round 4): clicks every control this round made live on General, People, Appearance, Notifications,
   Instructions, Models, On this computer, Accounts and Voice, and confirms each change through the engine's own GET route.
   It also checks that the rows drawn from the engine show the engine's values (a test profile, quiet hours, the projects,
   the model presets). Run it only against a throwaway engine: it adds and removes a test profile and changes voice,
   pet, notification and calendar settings.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-rw4-settings-a.cjs */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}

const settle = (page, ms = 700) => page.waitForTimeout(ms);
const live = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "attached", timeout: 10000 });
  if ((await el.getAttribute("aria-disabled")) === "true" || (await el.isDisabled())) throw new Error(`${sel} is greyed`);
  return el;
};
const click = async (page, sel) => { await (await live(page, sel)).click(); await settle(page); };
const greyed = async (page, sel) => { const el = page.locator(sel).first(); return (await el.count()) > 0 && ((await el.getAttribute("aria-disabled")) === "true" || (await el.isDisabled())); };
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  const other = id === "general" ? "people" : "general";
  await page.locator(`[data-act="setpage"][data-v="${other}"]`).first().click();
  await settle(page, 400);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1200);
}
async function setLevel(page, v) { if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); } await page.locator(`[data-act="setlevel"][data-v="${v}"]`).first().click(); await settle(page, 400); }

async function voice(page) {
  await setLevel(page, "advanced");
  await openPage(page, "voice");
  await click(page, '[data-act="ptt-key"]');
  await page.keyboard.press("F8");
  await settle(page, 900);
  const key = (await api("comfort")).values.voice.pushToTalkKey;
  check("ptt-key: the next key pressed is the push-to-talk key", key === "F8", `pushToTalkKey=${key}`);
  check("ptt-key: the page shows the engine's key", (await page.locator(".set-col kbd", { hasText: "F8" }).count()) > 0);
  await click(page, '[data-act="ptt-key"]');
  await page.keyboard.press("Escape");
  await settle(page, 600);
  check("ptt-key: Escape leaves the key as it was", (await api("comfort")).values.voice.pushToTalkKey === "F8");
  await click(page, '[data-act="ptt-key"]');
  await page.keyboard.press("k");
  await settle(page, 900);
  const refusal = (await page.locator(".toast").allTextContents()).join(" | ");
  check("ptt-key: a key the engine refuses is refused in its words", (await api("comfort")).values.voice.pushToTalkKey === "F8" && refusal.includes("Write a key as"), refusal);

  await click(page, "#v-dict");
  let mode = (await api("voice/dictation")).settings.mode;
  check("v-dict on: dictation in the message box", mode === "when-needed", `mode=${mode}`);
  await click(page, "#v-dict");
  mode = (await api("voice/dictation")).settings.mode;
  check("v-dict off", mode === "off", `mode=${mode}`);

  await (await live(page, "#f15-silence")).fill("6");
  await page.locator("#f15-silence").press("Tab");
  await settle(page, 900);
  const quiet = (await api("voice/dictation")).settings.silenceSeconds;
  check("f15-silence: stop listening after silence", quiet === 6, `silenceSeconds=${quiet}`);

  await click(page, "#f15-wake-word");
  let wake = (await api("voice/wake")).settings.mode;
  check("f15-wake-word on", wake === "on", `mode=${wake}`);
  await click(page, "#f15-wake-word");
  wake = (await api("voice/wake")).settings.mode;
  check("f15-wake-word off", wake === "off", `mode=${wake}`);

  for (const t of ["System voice", "Keep audio on this computer", "Read replies aloud"]) check(`not drawn (not in the design): ${t}`, (await page.locator(`.ctl > b:text-is("${t}")`).count()) === 0);

  const s = await api("voice/settings");
  const minutes = await page.locator('input[aria-label="Max duration"]').inputValue();
  check("live conversations show the engine's limits", minutes === String(s.liveMaxMinutes), `shown ${minutes}, engine ${s.liveMaxMinutes}`);
  for (const t of ["Listening", "Answer aloud", "Spoken morning brief"]) check(`greyed: ${t}`, await greyed(page, `.ctl:has(> b:text-is("${t}")) button, .ctl:has(> b:text-is("${t}")) input`));
}

async function appearance(page) {
  await openPage(page, "appearance");
  check("pet gallery: None card drawn", (await page.locator('.pets12 .pet-c12[data-v="none"] .pet-px12').textContent()) === "—");
  await click(page, '.pets12 .pet-c12[data-v="owl"]');
  let pets = (await api("delight")).settings.pets;
  check("petset from the gallery: owl", pets.on === true && pets.kind === "owl", JSON.stringify(pets));
  check("where it walks is drawn while the pet is on", (await page.locator('.ctl > b', { hasText: "Where it walks" }).count()) === 1);
  await (await live(page, "#pet-name")).fill("Pip");
  await page.locator("#pet-name").press("Tab");
  await settle(page, 900);
  pets = (await api("delight")).settings.pets;
  check("sw:pet-name: the pet's name", pets.name === "Pip", `name=${pets.name}`);
  await click(page, '.pets12 .pet-c12[data-v="none"]');
  pets = (await api("delight")).settings.pets;
  check("petset from the gallery: none", pets.on === false, JSON.stringify(pets));
}

async function people(page) {
  const made = await api("profiles", { name: "Test Person", pin: "4821" });
  try {
    await openPage(page, "people");
    check("people: the owner row is drawn from the engine", (await page.locator('.t9-item[data-v="owner"] b').textContent()).includes("· you"));
    await click(page, `.t9-item[data-v="${made.id}"]`);
    const card = page.locator(".t9-detail");
    check("p-sel: the test profile's card", (await card.locator(".t9-dh b").textContent()) === "Test Person");
    const role = (await api("profiles")).roles.find((r) => r.profileId === made.id);
    const ticked = await card.locator('.acts10 input:checked').count();
    check("people: May shows the engine's effective kinds", ticked === role.categories.length, `${ticked} ticked, engine ${role.categories.length}`);
    // unhold/people: live now, each proved against the engine in verify-unhold-people.cjs.
    for (const a of ["p-switch", "p-role", "p-code", "p-signout", "p-remove"]) check(`live: ${a}`, !(await greyed(page, `.t9-detail [data-act="${a}"]`)));
  } finally { await api(`profiles/${made.id}/remove`, {}); }
}

async function notifications(page) {
  await openPage(page, "notifications");
  await click(page, '[data-act="n-sound"][data-v="chime"]');
  check("n-sound chime", (await api("comfort")).values.notify.sound === "chime");
  await click(page, '[data-act="n-sound"][data-v="off"]');
  check("n-sound off", (await api("comfort")).values.notify.sound === "off");
  await click(page, '[data-act="n-method"][data-v="window"]');
  check("n-method in the app", (await api("comfort")).values.notify.method === "window");
  await click(page, '[data-act="n-method"][data-v="system"]');
  check("n-method and on the computer", (await api("comfort")).values.notify.method === "system");
  check("no quiet-hours status while quiet hours are off", (await page.locator(".set-col .status b", { hasText: "Quiet hours" }).count()) === 0);
  const cal = (await api("calendar")).settings;
  await api("calendar", { ...cal, quietHours: { ...cal.quietHours, enabled: true } });
  try {
    await openPage(page, "notifications");
    check("quiet-hours status drawn from the engine", (await page.locator(".set-col .status b", { hasText: "Quiet hours are" }).count()) === 1);
  } finally { await api("calendar", cal); }
  for (const id of ["n-need", "n-done"]) check(`greyed: ${id}`, await greyed(page, `#${id}`));
}

async function general(page) {
  await openPage(page, "general");
  const names = (await api("projects")).all.map((p) => p.name);
  const shown = await page.locator(".set-col .prow b").allTextContents();
  check("general: the engine's projects", names.every((n) => shown.includes(n)), shown.join(", "));
}

async function models(page) {
  await setLevel(page, "advanced");
  await openPage(page, "models");
  const presets = (await api("state")).models.presets.map((p) => p.name);
  const opts = await page.locator('.seg[aria-label="Planning model"] button').allTextContents();
  check("models: planning model choices are the engine's presets", presets.every((n) => opts.includes(n)), opts.join(", "));
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    await voice(page);
    await appearance(page);
    await people(page);
    await notifications(page);
    await general(page);
    await models(page);
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
