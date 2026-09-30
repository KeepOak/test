/* Settings › Saved sign-ins › Password manager › Windows, against a running throwaway engine:
     PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-settings-wincred.cjs
   In a headless browser: on an engine running on Windows, the Windows choice is live, and choosing it puts Windows
   Credential Manager first in the engine's list (GET /api/credentials/settings services[0]), keeping the other; choosing
   Bitwarden again puts that first. Only Branch's own setting changes: nothing asks Windows Credential Manager anything
   (a sign-in is read only when one is filled). On another system the choice stays greyed with its reason. */
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

async function passwords(page) {
  await page.locator('[data-act="setpage"][data-v="secrets"]').click();
  const { platform } = await api("credentials/settings");
  const win = page.locator('#main [data-v="windows"]').first();
  await win.waitFor({ timeout: 10000 });
  if (platform !== "win32") {
    check("Windows: greyed with its reason on another system", (await win.getAttribute("data-act")) === "vaultwinb17" && /part of Windows/.test(await win.getAttribute("data-tip") ?? ""));
    return;
  }
  check("Windows: live on an engine running on Windows", await until(async () => (await win.getAttribute("data-act")) === "vaultb17" && !(await win.isDisabled()), "live"));
  await page.locator('#main [data-act="vaultb17"][data-v="bitwarden"]').click();
  await until(async () => (await api("credentials/settings")).services[0] === "bitwarden", "bitwarden first");
  await page.locator('#main [data-act="vaultb17"][data-v="windows"]').click();
  check("vaultb17 windows: Windows Credential Manager first, Bitwarden kept", await until(async () => { const s = (await api("credentials/settings")).services; return s[0] === "windows" && s.includes("bitwarden"); }, "windows first"));
  check("the choice is drawn pressed", await until(async () => (await page.locator('#main [data-act="vaultb17"][data-v="windows"]').getAttribute("aria-pressed")) === "true", "pressed"));
  await page.locator('#main [data-act="vaultb17"][data-v="bitwarden"]').click();
  check("vaultb17 bitwarden: back first", await until(async () => (await api("credentials/settings")).services[0] === "bitwarden", "bitwarden first"));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setlevel"][data-v="technical"]').click();
    await passwords(page);
  } catch (error) { check("the run finished", false, error.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
