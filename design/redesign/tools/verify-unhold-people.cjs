/* unhold/people: clicks every person control this change made live and reads each change back through the engine.
   It starts its OWN fresh engine (a new temp data folder, allowed to reach this computer so the catalogue card can be
   proved against a stand-in service) and a stand-in OpenAI-shaped service, then stops both. Before the engine starts,
   the data folder is given one person ("Lee Verify") and one account waiting to be linked to them, which only an
   identity service's sign-in can leave (src/people/index.ts suggest), so Confirm has something real to confirm:
     npx tsc -p . && PORT=<free port> node design/redesign/tools/verify-unhold-people.cjs
   (the stand-in listens on PORT+1). Covered: invite (Overview) and p-invite (Team › People) with p-inv-role/p-inv-go,
   p-role, p-code, p-signout, p-remove, pin-add8/pin-do8/pin-rm8, si-owner/owner-pin-set, switchto and p-switch with pin-ok (a wrong PIN, the
   person's PIN, and the owner's PIN on the way back), a household person refused by the engine, Team › Signing in
   (si-mode, si-chain, si-stay, si-link, si-owner/owner-pin-set), and a catalogue card
   (signin) adding a key service end to end. PINs are made up here, never printed, and checked absent from the page,
   the console, browser storage and every request address. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { randomInt } = require("node:crypto");
const { join } = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 3743), STAND = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const pin = () => String(randomInt(100000, 999999)) + String(randomInt(10, 99));
const SAM_PIN = pin(), KIT_PIN = pin(), OWNER_PIN = pin(), LEE_PIN = pin();
const KEY = `sk-verify-${randomInt(1e9, 9e9)}`;
let TOKEN = "";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const greyed = async (page, sel) => { const el = page.locator(sel).first(); return (await el.count()) > 0 && ((await el.getAttribute("aria-disabled")) === "true" || (await el.isDisabled())); };
async function click(page, sel) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "attached", timeout: 10000 });
  if (await greyed(page, sel)) throw new Error(`${sel} is greyed`);
  await el.click();
  await settle(page);
}
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
  await settle(page, 600);
}
const toastText = async (page) => (await page.locator(".toast").allTextContents()).join(" | ");
const profiles = () => api("profiles");
const byName = async (name) => (await profiles()).profiles.find((p) => p.name === name);
const roleOf = async (id) => (await profiles()).roles.find((r) => r.profileId === id)?.grant.role;
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  const other = id === "general" ? "people" : "general";
  await page.locator(`[data-act="setpage"][data-v="${other}"]`).first().click();
  await settle(page, 400);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1200);
}
/* After a switch the window starts again as the new person (main.js watchPerson); wait for it to come back. */
async function afterSwitch(page) {
  await page.waitForEvent("load", { timeout: 8000 }).catch(() => null);
  await page.locator("#main").waitFor();
  await settle(page, 1500);
}

async function invite(page) {
  await act(page, "view", { v: "overview" });
  await click(page, '#main [data-act="invite"]');
  check("invite: the dialog's other two tabs are greyed (no engine route)", await greyed(page, '[data-act="p-inv-tab"][data-v="device"]') && await greyed(page, '[data-act="p-inv-tab"][data-v="keepoak"]'));
  await page.locator("#inv-n").fill("Sam Verify");
  await page.locator("#inv-pin").fill("12");
  await click(page, '[data-act="p-inv-go"]');
  check("p-inv-go: a PIN that is not four to eight digits is asked again, nobody added", (await page.locator("#inv-pin").getAttribute("aria-invalid")) === "true" && !(await byName("Sam Verify")));
  await click(page, '[data-act="p-inv-role"][data-v="child"]');
  await page.locator("#inv-pin").fill(SAM_PIN);
  await click(page, '[data-act="p-inv-go"]');
  const sam = await byName("Sam Verify");
  check("invite + p-inv-role + p-inv-go: POST /api/profiles added them as Child", sam && (await roleOf(sam.id)) === "child", sam ? await roleOf(sam.id) : "not added");
  check("p-inv-go: the window opens Team › People on them, toast in the prototype's words", (await page.locator(".t9-detail .t9-dh b").textContent()) === "Sam Verify" && (await toastText(page)).includes("Sam Verify is added."));
  await act(page, "ptab", { place: "team", v: "people" });
  await click(page, '#main [data-act="p-invite"]');
  await page.locator("#inv-n").fill("Kit Verify");
  await page.locator("#inv-pin").fill(KIT_PIN);
  await click(page, '[data-act="p-inv-go"]');
  const kit = await byName("Kit Verify");
  check("p-invite: Team › People adds Kit as Adult (the default)", kit && (await roleOf(kit.id)) === "adult");
  return { sam, kit };
}

async function card(page, sam) {
  await act(page, "ptab", { place: "team", v: "people" });
  await click(page, `.t9-item[data-v="${sam.id}"]`);
  await click(page, `.t9-detail [data-act="p-role"][data-v="adult"]`);
  check("p-role: POST /api/profiles/:id/role made Sam Adult", (await roleOf(sam.id)) === "adult");
  await click(page, `.t9-detail [data-act="p-role"][data-v="child"]`);
  check("p-role: and Child again", (await roleOf(sam.id)) === "child");
  const audit = (await api("audit?limit=50")).entries;
  check("p-role: the engine recorded each role change", audit.filter((e) => e.subject === "Sam Verify's role").length >= 2);
  await click(page, '.t9-detail [data-act="p-code"]');
  const said = await toastText(page);
  const issued = (await api("audit?action=token.issued&limit=5")).entries.find((e) => e.subject === "a one-time sign-in code");
  check("p-code: the engine's one-time code, with its minutes, and the engine recorded it", /One-time code: [A-Z0-9]{8}\. It works once, for \d+ minutes\./.test(said) && !!issued, said);
  const out = page.waitForResponse((r) => r.url().endsWith(`/api/people/${sam.id}/sign-out`));
  await click(page, '.t9-detail [data-act="p-signout"]');
  const answer = await (await out).json();
  check("p-signout: POST /api/people/:id/sign-out answered, toast in the prototype's words", typeof answer.signedOut === "number" && (await toastText(page)).includes("Sam is signed out on every device."));
}

async function pins(page) {
  await openPage(page, "permissions");
  await click(page, '[data-act="pin-add8"]');
  const item = page.locator('.pop [data-act="pin-do8"]').first();
  const key = await item.getAttribute("data-key"), field = await item.getAttribute("data-field");
  const offered = await page.locator('.pop [data-act="pin-do8"]').count();
  const unpinned = (await api("settings-kit")).settings.flatMap((s) => s.fields.filter((f) => !f.pinned)).length;
  check("pin-add8: the popover lists every setting the engine can pin that is not pinned", offered === unpinned, `${offered} of ${unpinned}`);
  await item.click();
  await settle(page, 1200);
  const kit = await api("settings-kit");
  check("pin-do8: POST /api/settings-kit/pins pinned it", kit.pins.some((x) => x.key === key && x.field === field), `${key}.${field}`);
  await click(page, `[data-act="pin-rm8"][data-key="${key}"][data-field="${field}"]`);
  check("pin-rm8: and Unpin took the pin off", !(await api("settings-kit")).pins.some((x) => x.key === key && x.field === field));
}

async function switching(page, sam, kit) {
  await click(page, '[data-act="owner"]');
  await click(page, `.pop [data-act="switchto"][data-v="${sam.id}"]`);
  await page.locator("#pin-try").fill("0000");
  await click(page, '[data-act="pin-ok"]');
  check("switchto: a wrong PIN is refused in the engine's words, nobody switched", (await toastText(page)).includes("That PIN is not right") && (await profiles()).active === null);
  await page.locator("#pin-try").fill(SAM_PIN);
  await click(page, '[data-act="pin-ok"]');
  await afterSwitch(page);
  check("switchto + pin-ok: the right PIN switches to Sam (GET /api/profiles active)", (await profiles()).active?.id === sam.id);
  const count = (await profiles()).profiles.length;
  await act(page, "invite");
  await page.locator("#inv-n").fill("Not Allowed");
  await page.locator("#inv-pin").fill(pin());
  await click(page, '[data-act="p-inv-go"]');
  check("household: Sam can't invite; the engine's refusal is shown", (await toastText(page)).includes("belongs to the owner") && (await profiles()).profiles.length === count);
  await act(page, "dlg-close");
  await act(page, "p-role", { id: kit.id, v: "child" });
  check("household: Sam can't change Kit's role", (await toastText(page)).includes("belongs to the owner") && (await roleOf(kit.id)) === "adult");
  await click(page, '[data-act="owner"]');
  await click(page, '.pop [data-act="switchto"][data-v=""]');
  await afterSwitch(page);
  check("switchto: back to the owner with no owner PIN set", (await profiles()).active === null);
}

/* Team › Signing in: "Ask for my PIN when switching back to me" (si-owner). */
async function ownerPinSwitch(page, on) {
  await act(page, "ptab", { place: "team", v: "signin" });
  await page.locator("#si-owner").waitFor({ state: "attached" });
  if (await greyed(page, "#si-owner")) throw new Error("#si-owner is greyed");
  await page.locator("#si-owner").click();
  await settle(page);
  if (!on) return;
  await page.locator("#owner-pin-new").fill("12");
  await click(page, '[data-act="owner-pin-set"]');
  check("si-owner: a PIN that is not four to eight digits is asked again, nothing set", (await page.locator("#owner-pin-new").getAttribute("aria-invalid")) === "true" && (await profiles()).ownerPin === false);
  await page.locator("#owner-pin-new").fill(OWNER_PIN);
  await click(page, '[data-act="owner-pin-set"]');
}

async function ownerPin(page, kit) {
  await ownerPinSwitch(page, true);
  check("si-owner + owner-pin-set: POST /api/profiles/owner-pin set the owner's PIN, the switch shows it", (await profiles()).ownerPin === true && await page.locator("#si-owner").isChecked());
  await act(page, "ptab", { place: "team", v: "people" });
  await click(page, `.t9-item[data-v="${kit.id}"]`);
  await click(page, '.t9-detail [data-act="p-switch"]');
  await page.locator("#pin-try").fill(KIT_PIN);
  await click(page, '[data-act="pin-ok"]');
  await afterSwitch(page);
  check("p-switch + pin-ok: the card switches to Kit with Kit's PIN", (await profiles()).active?.id === kit.id);
  await click(page, '[data-act="owner"]');
  await click(page, '.pop [data-act="switchto"][data-v=""]');
  check("switchto: going back asks for the owner's PIN", (await page.locator(".dlg h2").textContent()) === "The owner’s PIN");
  await page.locator("#pin-try").fill(KIT_PIN);
  await click(page, '[data-act="pin-ok"]');
  check("pin-ok: a wrong owner PIN is refused, still Kit", (await toastText(page)).includes("That PIN is not right") && (await profiles()).active?.id === kit.id);
  await page.locator("#pin-try").fill(OWNER_PIN);
  await click(page, '[data-act="pin-ok"]');
  await afterSwitch(page);
  check("pin-ok: the owner's PIN brings the owner back", (await profiles()).active === null);
  await ownerPinSwitch(page, false);
  check("si-owner off: POST /api/profiles/owner-pin {pin: null} switched it off", (await profiles()).ownerPin === false && !(await page.locator("#si-owner").isChecked()));
}

async function removeKit(page, kit) {
  await act(page, "ptab", { place: "team", v: "people" });
  await click(page, `.t9-item[data-v="${kit.id}"]`);
  await click(page, '.t9-detail [data-act="p-remove"]');
  check("p-remove: POST /api/profiles/:id/remove took Kit off this computer", !(await byName("Kit Verify")) && (await toastText(page)).includes("Removed."));
}

/* Team › Signing in: who may sign in from their own device, how they prove it, how long they stay, and a waiting account. */
async function signingIn(page, lee) {
  await act(page, "ptab", { place: "team", v: "signin" });
  const card = () => api("people/settings");
  await click(page, '[data-act="si-mode"][data-v="on"]');
  check("si-mode: POST /api/people/settings switched signing in from other devices on", (await card()).settings.mode === "on");
  check("si-mode: the page shows the engine's mode", (await page.locator('[data-act="si-mode"][data-v="on"]').getAttribute("aria-pressed")) === "true");
  await click(page, '[data-act="si-stay"][data-v="60"]');
  check("si-stay: stay signed in for 1 hour", (await card()).settings.sessionMinutes === 60);
  await click(page, '[data-act="si-chain"][data-v="passkey"]');
  check("si-chain: a passkey is added to every person's checks", JSON.stringify((await card()).settings.chain) === JSON.stringify(["pin", "passkey"]));
  await click(page, '[data-act="si-chain"][data-v="passkey"]');
  await click(page, '[data-act="si-chain"][data-v="pin"]');
  const said = await toastText(page);
  check("si-chain: taking the last check away is refused by the engine, the PIN stays", JSON.stringify((await card()).settings.chain) === JSON.stringify(["pin"]) && said.length > 0, said.slice(0, 80));
  await click(page, '[data-act="si-link"]');
  const after = await card();
  check("si-link: POST /api/people/links/confirm linked the waiting account to Lee", after.waiting.length === 0 && after.settings.links.some((l) => l.profileId === lee && l.subject === "sub-lee-1"));
  await click(page, '[data-act="si-mode"][data-v="off"]');
  check("si-mode off again", (await card()).settings.mode === "off");
}

async function catalogueCard(page, seen) {
  await openPage(page, "accounts");
  await click(page, '[data-act="addacct"]:not([data-v])');
  await page.locator(".aa-list12").waitFor();
  await click(page, '[data-act="aa-grp"][data-v="custom"]');
  await click(page, '[data-act="signin"][data-v="custom"]');
  check("signin: a key service opens the key step, never a site sign-in", (await page.locator("#aa-key").count()) === 1 && !(await page.content()).includes("Continue on their site"));
  await page.locator('[data-k="baseUrl"]').fill(`http://127.0.0.1:${STAND}/v1`);
  await page.locator("#aa-key").fill(KEY);
  await click(page, '[data-act="aa-key"]');
  await page.locator("#aa-name").waitFor({ timeout: 10000 });
  const pool = (await api("accounts")).pools.find((p) => p.pool === "custom");
  check("signin + aa-key: POST /api/connections/from-preset made the connection (GET /api/accounts)", pool?.accounts.length === 1);
  check("signin: the stand-in service was asked with that key", seen.some((s) => s === `Bearer ${KEY}`));
  check("signin: the key is not in the window after the POST", !(await page.content()).includes(KEY));
  await click(page, '[data-act="aa-done"]');
  check("aa-done: the account is added", (await toastText(page)).includes("is added."));
}

function startStandIn(seen) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "stand-in-model" }] }));
    }).listen(STAND, "127.0.0.1", () => resolve(server));
  });
}
/* One person and one waiting account, written the way the engine keeps them, before the engine starts. */
async function seed(dir) {
  const { pathToFileURL } = require("node:url");
  const { createBranch } = await import(pathToFileURL(join(process.cwd(), "dist/index.js")).href);
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(dir, "workspace"), dataDir: join(dir, "data"), provider });
  try {
    const lee = app.store.profiles.create({ name: "Lee Verify", pin: LEE_PIN });
    app.store.save("settings", app.runtime.owner, "people-oidc-waiting", { waiting: [{ provider: "family-sso", profileId: lee.id, subject: "sub-lee-1", email: "lee@example.com", at: new Date().toISOString() }] });
    return lee.id;
  } finally { await app.close(); }
}

function startEngine(dir) {
  writeFileSync(join(dir, "integrations.json"), JSON.stringify({ web: { allowPrivateAddresses: true } }));
  const engine = spawn(process.execPath, ["dist/cli.js", "start"], { env: { ...process.env, BRANCH_DATA_DIR: join(dir, "data"), BRANCH_PORT: String(PORT), BRANCH_INTEGRATIONS: join(dir, "integrations.json") } });
  const token = new Promise((resolve, reject) => {
    engine.stdout.on("data", (d) => { const m = /paste into browser\): ([a-f0-9]+)/.exec(String(d)); if (m) resolve(m[1]); });
    engine.on("exit", (code) => reject(new Error(`the engine stopped (${code})`)));
  });
  return { engine, token };
}

/* Nothing typed as a PIN may be left where the window keeps things or says things. */
async function noPinInWindow(page, logged, urls) {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  const where = [stored, await page.content(), logged.join("\n"), urls.join("\n")];
  const leaked = [SAM_PIN, KIT_PIN, OWNER_PIN, LEE_PIN].filter((p) => where.some((w) => w.includes(p)));
  check("no PIN in the page, the console, browser storage or any request address", leaked.length === 0, `${leaked.length} found`);
}

(async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "verify-unhold-people-"));
  const seen = [], errors = [], logged = [], urls = [];
  const stand = await startStandIn(seen);
  const lee = await seed(dir);
  const { engine, token } = startEngine(dir);
  let browser;
  try {
    TOKEN = await token;
    await api("onboarding", { done: true });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => logged.push(m.text()));
    page.on("request", (r) => urls.push(r.url()));
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    const { sam, kit } = await invite(page);
    await card(page, sam);
    await pins(page);
    await switching(page, sam, kit);
    await ownerPin(page, kit);
    await removeKit(page, kit);
    await signingIn(page, lee);
    await catalogueCard(page, seen);
    await noPinInWindow(page, logged, urls);
  } catch (error) { check("the run finished", false, error.message); }
  finally {
    await browser?.close();
    engine.kill();
    stand.close();
    await new Promise((r) => setTimeout(r, 800));
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { console.log(`left ${dir}: ${error.message}`); }
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
