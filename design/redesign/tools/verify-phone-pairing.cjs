// B6: verifies that a new phone pairs from the window's "Pair a phone" code, end to end, against a FRESH engine (Devices
// off). The phone is a scripted stand-in: an Ed25519 key made here reads the link and the six digits off the dialog,
// answers the invitation over the engine's open door (POST /api/devices/pair), shows its check code, waits for the
// owner's "Let it in" (clicked in the real window, after ticking that the codes match), asks how it went
// (POST /api/devices/pair/status) and collects its session (POST /api/devices/pair/session), then opens the window with
// that session as the phone app does. "Get Branch on your phone" is opened from the pair dialog and from Settings ›
// Computer; with no phone app in this copy, the engine's own reason is shown and no download door is opened.
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-phone-pairing.cjs
const { chromium } = require("playwright");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");

const PORT = process.env.PORT || "3487", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function call(path, body, key = TOKEN) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function api(path, body) {
  const { status, body: data } = await call(path, body);
  if (status >= 400) throw new Error(`${path}: ${status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(action, ok, how) { results.push([action, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${action}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(150); } }

/* The stand-in phone: its own key, and nothing of the owner's. */
function standInPhone() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const hex = createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 8).toUpperCase();
  return { publicKey, check: `${hex.slice(0, 4)} ${hex.slice(4)}`, sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}

async function signIn(page, key) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(key);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('[data-act="machines"]').first().waitFor();
}
async function openPairAPhone(page) {
  await page.locator('[data-act="machines"]').first().click();
  await page.locator('.pop [data-act="addcomp"]').click();
  await page.locator('.dlg [data-act="ac-tab"][data-v="phone"]').click();
  await page.locator('.dlg [data-act="pair"]').click();
}

/* Pair a phone with Devices off: the engine's words; switched on, the invitation; Cancel stops it. */
async function pairOnThenCancel(page) {
  await openPairAPhone(page);
  await page.locator('.dlg [data-act="pair-on"]').waitFor();
  const refusal = await page.locator(".dlg [role=alert]").innerText();
  check("pair (Devices off)", (await api("devices")).mode === "off" && /switched off/.test(refusal), `the engine's refusal is shown: "${refusal}"`);
  await page.locator('.dlg [data-act="pair-on"]').click();
  await page.locator(".dlg #pair-code").waitFor();
  check("pair-on", !!(await api("devices")).invitation, "GET /api/devices: an invitation on offer");
  check("no Get the app in Pair a phone", (await page.locator('.dlg [data-act="phone-app"]').count()) === 0, "the prototype's Pair a phone has no such button");
  await page.locator('.dlg [data-act="pair-cancel"]').click();
  check("pair-cancel stops the invitation", await until(async () => (await api("devices")).invitation === null), "GET /api/devices: no invitation on offer");
}

/* The whole pairing: the window's code, the phone's check code, the owner's tick and yes, the phone's session. */
async function pairPhone(page, browser, stamp) {
  await openPairAPhone(page);
  await page.locator(".dlg #pair-code").waitFor();
  const code = (await page.locator(".dlg #pair-code").innerText()).replace(/\D/g, "");
  const link = await page.locator(".dlg #pair-link").inputValue();
  const offer = /\/devices\/pair\?offer=([a-f0-9]{32})$/.exec(link)?.[1];
  check("pair (phone code)", /^\d{6}$/.test(code) && !!offer && (await page.locator(".dlg .qr12").count()) === 1 && (await api("devices")).invitation?.id === offer,
    "the dialog shows the square code, the link and the six digits of the invitation GET /api/devices has on offer");
  const phone = standInPhone(), name = `Phone ${stamp}`;
  const redeemed = await call("devices/pair", { offer, code, name, platform: "ios", publicKey: phone.publicKey, offers: [] }, null);
  check("the phone answers the code", redeemed.status === 200 && redeemed.body.status === "waiting", `POST /api/devices/pair → ${redeemed.status} ${redeemed.body.status}`);
  const requestId = redeemed.body.requestId;
  const early = await call("devices/pair/session", { requestId, signature: phone.sign(`branch-phone-session-v1\n${requestId}`) }, null);
  check("no session before the yes", early.status === 403, `POST /api/devices/pair/session while waiting → ${early.status}`);
  await page.locator('.dlg [data-act="ph-paired-dlg"]').click();
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 6000 });
  const asks = await page.locator(".dlg-b").innerText();
  const waiting = (await api("devices")).requests.find((r) => r.id === requestId);
  check("ph-paired-dlg (the request)", waiting?.phone === true && waiting.check === phone.check && asks.includes(phone.check) && !asks.includes("can do nothing"),
    `the dialog names ${name}, shows check code ${phone.check} (the phone's own) and not the device note, which is not true of a phone`);
  check("pair-letin waits for the tick", await page.locator('.dlg [data-act="pair-letin"]').isDisabled(), "Let it in is disabled until The code matches is ticked");
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const device = await until(async () => (await api("devices")).devices.find((d) => d.name === name));
  check("pair-letin", device?.platform === "ios", "GET /api/devices lists the phone");
  const status = await call("devices/pair/status", { requestId, signature: phone.sign(`branch-node-status-v1\n${requestId}`) }, null);
  check("the phone learns it is let in", status.body.status === "approved", `POST /api/devices/pair/status → ${status.body.status}`);
  const session = await call("devices/pair/session", { requestId, signature: phone.sign(`branch-phone-session-v1\n${requestId}`) }, null);
  check("the phone collects its session", session.status === 200 && typeof session.body.token === "string" && /^[a-f0-9]{16}$/.test(session.body.deviceId ?? "") && typeof session.body.deviceKey === "string",
    `POST /api/devices/pair/session → ${session.status}, {token, deviceId, deviceKey} (the /api/pair shape)`);
  const replay = await call("devices/pair/session", { requestId, signature: phone.sign(`branch-phone-session-v1\n${requestId}`) }, null);
  check("once only", replay.status === 403, `the same request again → ${replay.status}`);
  const state = await call("state", undefined, session.body.token);
  check("the session works", state.status === 200, `GET /api/state with the phone's session → ${state.status}`);
  const phonePage = await browser.newPage({ viewport: { width: 393, height: 852 }, serviceWorkers: "block" });
  await signIn(phonePage, session.body.token);
  check("the phone opens the window", (await phonePage.locator('[data-act="machines"]').count()) > 0, "the window signs in with the phone's session");
  await phonePage.close();
  return device;
}

/* Settings › Computer: Get Branch on your phone (the engine's reason, no download door), then Remove the phone. */
async function settings(page, device) {
  await page.locator('[data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  await page.locator('#main [data-act="phone-app"]').click();
  const view = await api("phone-app");
  await page.locator('.dlg-h:has-text("Get Branch on your phone")').waitFor();
  check("phone-app (from Settings › Computer)", (await page.locator(".dlg-b").innerText()).includes(view.reason ?? "\u0000"), "the same dialog, with the engine's reason");
  const share = await call("phone-app/share", {});
  check("phone-app/share refuses with no app", share.status === 409 && share.body.error === view.reason, `POST /api/phone-app/share → ${share.status} "${share.body.error}"`);
  await page.locator('.dlg [data-act="dlg-close"]').last().click();
  const row = page.locator(`#main .prow:has-text("${device.name}")`);
  await row.locator('[data-act="dev-remove"]').click();
  await page.locator('.dlg [data-act="dev-remove-yes"]').click();
  check("dev-remove-yes (phone)", await until(async () => !(await api("devices")).devices.some((d) => d.id === device.id)), "GET /api/devices no longer lists the phone");
}

(async () => {
  const stamp = Date.now().toString(36);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
    await signIn(page, TOKEN);
    await pairOnThenCancel(page);
    const device = await pairPhone(page, browser, stamp);
    await settings(page, device);
  } catch (error) {
    check("script", false, error.message.split("\n")[0]);
    await page.screenshot({ path: require("path").join(require("os").tmpdir(), "verify-phone-pairing-failure.png") }).catch(() => {});
  }
  await browser.close();
  console.log("\n| Action | Result | How it was confirmed |\n|---|---|---|");
  for (const [a, r, h] of results) console.log(`| ${a} | ${r} | ${h} |`);
  console.log(`\npage errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
  process.exit(results.every((r) => r[1] === "PASS") && !errors.length ? 0 : 1);
})();
