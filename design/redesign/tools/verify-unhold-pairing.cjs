// Verifies the pairing and device controls made live on claude/unhold-pairing, against a FRESH engine (Devices off):
// each control is clicked in the real window and the change is read back from GET /api/devices. The phone and the
// other computer are scripted stand-ins: an Ed25519 key made here answers the invitation over the engine's own open
// pairing door (POST /api/devices/pair), with the link and number read off the dialog, exactly as a device would.
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-unhold-pairing.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { generateKeyPairSync } = require("node:crypto");

const PORT = process.env.PORT || "3461", TOKEN = process.env.TOKEN;
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

/* A stand-in device: its own key, answering the invitation the dialog shows, with no session key at all. */
/* Everything it sends is read off the dialog (the link carries the invitation's id); nothing comes from the owner's API. */
async function standIn(page, name, platform, codeSelector, linkSelector) {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  /* A field's value, or an element's words (the phone dialog's Link is a read-only field since setup-polish-2). */
  const read = (selector) => page.locator(selector).first().evaluate((el) => el.value ?? el.textContent);
  const code = (await read(codeSelector)).replace(/\D/g, "");
  const offer = /offer=([a-f0-9]{32})/.exec(await read(linkSelector))?.[1];
  const answer = await call("devices/pair", { offer, code, name, platform, publicKey: key }, null);
  if (answer.status !== 200) throw new Error(`the stand-in ${name} could not answer: ${answer.status} ${answer.body.error ?? ""}`);
  return answer.body.requestId;
}

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('[data-act="machines"]').first().waitFor();
}
async function toComputerPage(page) {
  await page.locator('[data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  await page.locator('#main [data-act="comp-add"]').waitFor();
}
const byName = async (name) => (await api("devices")).devices.find((d) => d.name === name);

/* Settings › Computer › Add a computer › Another computer with Branch; Devices is off on a fresh engine. */
async function pairComputer(page, stamp) {
  await page.locator('#main [data-act="comp-add"]').click();
  const greyedKinds = [];
  for (const v of ["sandbox", "cloud", "remote"]) if (await page.locator(`.dlg [data-act="comp-add-go"][data-v="${v}"]`).isDisabled()) greyedKinds.push(v);
  check("comp-add-go (other kinds)", greyedKinds.length === 3, "a private computer, a cloud computer and remote desktop or SSH stay greyed (not in the engine / not pairing)");
  await page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]').click();
  await page.locator('.dlg [data-act="pair-on"]').waitFor();
  const refusal = await page.locator(".dlg [role=alert]").innerText();
  check("pair (Devices off)", (await api("devices")).mode === "off" && /switched off/.test(refusal), `the engine's refusal is shown: "${refusal}"`);
  await page.locator('.dlg [data-act="pair-on"]').click();
  await page.locator(".dlg .ko-code").waitFor();
  const view = await api("devices");
  check("pair-on", view.mode === "when-needed" && !!view.invitation, "GET /api/devices: mode when-needed, an invitation on offer");
  const shown = (await page.locator(".dlg .ko-code").innerText()).replace(/\D/g, "");
  check("comp-add-go (pair)", /^\d{6}$/.test(shown) && (await page.locator(".dlg .pair-cmd15").innerText()).includes(view.invitation.id), "the dialog shows the six-digit number and the link of the invitation GET /api/devices has on offer");
  const name = `Studio ${stamp}`;
  const requestId = await standIn(page, name, "linux", ".dlg .ko-code", ".dlg .pair-cmd15");
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 8000 });
  const waiting = (await api("devices")).requests.find((r) => r.id === requestId);
  const text = await page.locator(".dlg-b").innerText();
  check("the request waits (approval shown)", waiting?.status === "waiting" && text.includes(waiting.check) && !(await byName(name)), `the dialog names it and shows check code ${waiting?.check}; nothing is let in yet`);
  check("pair-letin waits for the tick", await page.locator('.dlg [data-act="pair-letin"]').isDisabled(), "Let it in is disabled until The code matches is ticked");
  await page.locator("#pair-match").check();
  check("sw:pair-match", !(await page.locator('.dlg [data-act="pair-letin"]').isDisabled()), "ticking it enables Let it in");
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const device = await until(() => byName(name));
  check("pair-letin", device?.platform === "linux" && device.enabled.length === 0, "GET /api/devices lists the computer, with everything off");
  await page.locator(`#main .comp7-card:has-text("${name}") [data-act="dev-remove"]`).waitFor();
  check("Settings › Computer lists it", true, "its card with Remove is drawn after the yes");
  return device;
}

/* The computers popover › Add a computer or phone › With a code, answered, then refused. */
async function refuseFromCodeTab(page, stamp) {
  await page.locator('[data-act="machines"]').first().click();
  await page.locator('.pop [data-act="addcomp"]').click();
  check("What happens after pairing", (await page.locator(".dlg .status").innerText()).includes("What happens after pairing"), "the note is drawn under the tabs");
  await page.locator('.dlg [data-act="ac-tab"][data-v="code"]').click();
  await page.locator(".dlg .ko-code").waitFor();
  check("ac-tab (With a code)", !!(await api("devices")).invitation, "switching to the tab made an invitation (GET /api/devices)");
  const name = `Stranger ${stamp}`;
  const requestId = await standIn(page, name, "win32", ".dlg .ko-code", ".dlg .pair-cmd15");
  await page.locator('.dlg [data-act="pair-refuse"]').waitFor({ timeout: 8000 });
  await page.locator('.dlg [data-act="pair-refuse"]').click();
  await wait(500);
  const view = await api("devices");
  check("pair-refuse", !view.devices.some((d) => d.name === name) && !view.requests.some((r) => r.id === requestId), "GET /api/devices: not paired, and the request no longer waits");
}

/* The phone dialog: Cancel and the close button both stop the invitation; then a phone is let in. */
async function phone(page, stamp) {
  const open = async () => {
    await page.locator('[data-act="machines"]').first().click();
    await page.locator('.pop [data-act="addcomp"]').click();
    await page.locator('.dlg [data-act="ac-tab"][data-v="phone"]').click();
    await page.locator('.dlg [data-act="pair"]').click();
    await page.locator(".dlg .alt12").waitFor();
  };
  await open();
  const invitation = (await api("devices")).invitation;
  check("pair (phone)", !!invitation && (await page.locator(".dlg .qr12").count()) === 1 && (await page.locator(".dlg .count12").innerText()).includes("left"),
    "the square code is drawn from the engine's invitation, with the countdown from its expiresAt");
  await page.locator('.dlg [data-act="pair-cancel"]').click();
  check("pair-cancel", await until(async () => (await api("devices")).invitation === null), "GET /api/devices has no invitation on offer");
  await open();
  await page.locator('.dlg-h [data-act="dlg-close"]').click();
  check("closing the dialog cancels", await until(async () => (await api("devices")).invitation === null), "GET /api/devices has no invitation after the close button");
  await open();
  const name = `Phone ${stamp}`;
  await standIn(page, name, "ios", ".dlg #pair-code", ".dlg #pair-link");
  await page.locator('.dlg [data-act="ph-paired-dlg"]').click();
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 4000 });
  check("ph-paired-dlg", true, "the phone's waiting request is shown at once");
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const device = await until(() => byName(name));
  check("pair-letin (phone)", device?.platform === "ios", "GET /api/devices lists the phone");
  return device;
}

/* Settings › Computer › Phones lent to Branch: Stop lending, then Remove both devices. */
async function lendAndRemove(page, phoneDevice, computer) {
  await api(`devices/${phoneDevice.id}/switch`, { capability: "camera", on: true }); // the phone lends its camera (set up through the engine)
  await page.locator('[data-act="setpage"][data-v="general"]').first().click();
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  const row = page.locator(`#main .prow:has-text("${phoneDevice.name}")`);
  await row.locator('[data-act="lend15"]').waitFor();
  check("phone row", (await row.innerText()).includes("take a photo with the camera"), "the row names what it lends in the engine's words");
  await row.locator('[data-act="lend15"]').click();
  check("lend15 (Stop lending)", await until(async () => (await byName(phoneDevice.name))?.enabled.length === 0), "GET /api/devices: nothing switched on for the phone");
  await row.locator('[data-act="dev-remove"]').click();
  check("dev-remove asks first", (await page.locator(".dlg b").innerText()) === phoneDevice.name && !!(await byName(phoneDevice.name)), "a confirm names the phone; nothing is removed yet");
  await page.locator('.dlg [data-act="dev-remove-yes"]').click();
  check("dev-remove-yes (phone)", await until(async () => !(await byName(phoneDevice.name))), "GET /api/devices no longer lists the phone");
  await page.locator(`#main .comp7-card:has-text("${computer.name}") [data-act="dev-remove"]`).click();
  await page.locator('.dlg [data-act="dev-remove-yes"]').click();
  check("dev-remove-yes (computer)", await until(async () => !(await byName(computer.name))), "GET /api/devices no longer lists the computer");
  check("empty phones", (await page.locator("#main .empty:has-text('No phone is lent')").count()) === 1, "the prototype's empty line shows");
}

(async () => {
  const stamp = Date.now().toString(36);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await signIn(page);
    await toComputerPage(page);
    const computer = await pairComputer(page, stamp);
    await refuseFromCodeTab(page, stamp);
    const phoneDevice = await phone(page, stamp);
    await lendAndRemove(page, phoneDevice, computer);
  } catch (error) {
    check("script", false, error.message.split("\n")[0]);
    await page.screenshot({ path: require("path").join(require("os").tmpdir(), "verify-unhold-pairing-failure.png") }).catch(() => {});
  }
  await browser.close();
  console.log("\n| Action | Result | How it was confirmed |\n|---|---|---|");
  for (const [a, r, h] of results) console.log(`| ${a} | ${r} | ${h} |`);
  console.log(`\npage errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
  process.exit(results.every((r) => r[1] === "PASS") && !errors.length ? 0 : 1);
})();
