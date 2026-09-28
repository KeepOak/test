/* Settings › Computer & browser: Site skills and each Trunk's browser profile, against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-sites.cjs
   Installs a skill package that knows one website and switches it on, makes a Trunk and a saved sign-in under that Trunk's
   own name (the name browser.profile "keep" gives it), then in a headless browser: Site skills shows "See 1", its dialog
   lists the website with its notes, Forget asks first and then removes the skill (GET /api/browser/site-skills empty
   again); Browser profiles that stay signed in lists the Trunk's own profile under the Trunk's name. Nothing leaves this
   computer. */
const path = require("node:path");
const PW = process.env.PLAYWRIGHT ?? "playwright";
const { chromium } = require(PW);

const BASE = `http://127.0.0.1:${process.env.PORT}`, TOKEN = process.env.TOKEN;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const until = async (read, what) => {
  for (let i = 0; i < 150; i++) { if (await read().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 100)); }
  console.log(`  never happened: ${what}`);
  return false;
};

async function prepare() {
  const { packSkill } = await import(path.join(__dirname, "../../../dist/skill-package.js").replaceAll("\\", "/").replace(/^([A-Z]):/, "file:///$1:"));
  await api("onboarding", { done: true });
  const document = ["---", "name: verify-shop", "description: Knows the quirks of one shop.", "---", "", "# The shop", ""].join("\n");
  const site = JSON.stringify({ site: { hosts: ["shop.example.com"], notes: "Close the cookie notice first." } });
  const bytes = packSkill({ files: { "SKILL.md": document, "site.json": site }, author: "Verify", packageVersion: "1.0.0" });
  const installed = await api("skills/package/install", { file: bytes.toString("base64"), approve: true });
  const skill = installed.skill;
  await api(`skills/${skill.id}/activate`, { expectedRevision: skill.revision, version: skill.headVersion });
  const modes = await api("trunks");
  if (modes.modes?.trunks !== "on") await api("trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await api("trunks", { name: "Verify Scout" });
  const name = `trunk-${trunk.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;
  await api("browser/profiles", { name });
  return { trunk, name };
}

async function sites(page) {
  await page.locator('[data-act="setpage"][data-v="computer"]').click();
  const see = page.locator('#main [data-act="siteb17"]');
  check("Site skills: See 1", await until(async () => /1/.test(await see.textContent()), "See 1"));
  await see.click();
  const row = page.locator(".dlg .prow", { hasText: "shop.example.com" });
  check("siteb17: the dialog lists the website and its notes", await until(async () => (await row.count()) === 1 && /cookie notice/.test(await row.textContent()), "listed"));
  await row.locator('[data-act="siteforgetb17"]').click();
  const sure = page.locator('.dlg [data-act="siteforgetb17"][data-sure="1"]');
  check("siteforgetb17 asks first, naming the skill", await until(async () => (await sure.count()) === 1 && /verify-shop/.test(await page.locator(".dlg").textContent()), "confirm"));
  await sure.click();
  check("siteforgetb17: the skill is removed and the list is empty", await until(async () => (await api("browser/site-skills")).sites.length === 0, "forgotten"));
  check("siteb17: the list is drawn again, empty", await until(async () => (await page.locator(".dlg .empty").count()) === 1, "empty list"));
  await page.locator('.dlg [data-act="dlg-close"]').last().click();
}

async function profiles(page, s) {
  const see = page.locator('#main [data-act="demob17"][data-k="profiles"]');
  await see.waitFor({ timeout: 10000 });
  await see.scrollIntoViewIfNeeded();
  await see.click();
  check("profiles: the Trunk's own profile is listed under the Trunk's name", await until(async () => /Verify Scout/.test(await page.locator(".dlg").textContent()), "listed"));
  await page.keyboard.press("Escape");
  await api("browser/profiles/remove", { name: s.name });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const s = await prepare();
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await sites(page);
    await profiles(page, s);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
