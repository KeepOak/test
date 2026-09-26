// Verifies setup's "Another computer" (step 2, "Where should Branch run?") against a FRESH engine, with setup open as a
// new owner sees it: the card opens the same "Pair another computer" dialog as Settings (flows/pair.js), and it is walked
// through to connected. The other computer is a scripted stand-in built from the engine's own `branch node` code
// (dist/devices/node/client.js): it answers the invitation with the link and number read off the dialog, waits for the
// owner's yes, then dials in with its own Ed25519 key, exactly as `branch node pair` and `branch node run` do. Every
// step is read back from GET /api/devices or GET /api/deployment.
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Run from the repo root: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-setup-another-computer.cjs
// The Tailscale button is checked as offered, not pressed: pressing it opens a real door on this computer's tailnet.
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { generateKeyPairSync } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PORT = process.env.PORT || "3487", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(action, ok, how) { results.push([action, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${action}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(150); } }

const card = (v) => `.ob9 [data-k="where"][data-v="${v}"]`;
const REMOTE = '.ob9 [data-act="ob-where-remote"]';

/* A fresh engine opens on setup: sign in, tick the box on Welcome, press Start, and land on "Where should Branch run?". */
async function toWhere(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".ob9").waitFor({ timeout: 15000 });
  await page.locator(".ob9 .ob-agree").click();
  await page.locator('.ob9 [data-act="ob-next"]').click();
  await page.locator('.ob9[data-step="1"]').waitFor();
}

async function looks(page) {
  const state = async (sel) => page.locator(sel).evaluate((el) => ({ pressed: el.getAttribute("aria-pressed"), soon: el.classList.contains("soon"), off: el.getAttribute("aria-disabled") === "true" }));
  const [here, remote, keepoak] = [await state(card("this")), await state(REMOTE), await state(card("keepoak"))];
  check("This computer is the default", here.pressed === "true" && remote.pressed === "false", "on arrival This computer is picked and Another computer is not");
  check("ob-where-remote is drawn live", !remote.soon && !remote.off, "Another computer carries no .soon and no aria-disabled");
  check("A KeepOak computer untouched", keepoak.soon && keepoak.off, "A KeepOak computer stays greyed, as it was");
}

/* Devices ships off: the card's dialog shows the engine's refusal and Switch it on, then the invitation. */
async function firstOpen(page) {
  await page.locator(REMOTE).click();
  await page.locator(".dlg").waitFor();
  check("the card opens Pair another computer", (await page.locator(".dlg h2").innerText()) === "Pair another computer", "the dialog is the Settings one, over setup");
  await page.locator('.dlg [data-act="pair-on"]').waitFor();
  const refusal = await page.locator(".dlg [role=alert]").innerText();
  check("Devices off: the engine's words", (await api("devices")).mode === "off" && /switched off/.test(refusal), `shown: "${refusal}"`);
  await page.locator('.dlg [data-act="pair-on"]').click();
  await page.locator(".dlg .ko-code").waitFor();
  const view = await api("devices");
  const cmd = await page.locator(".dlg .pair-cmd15").innerText();
  check("the invitation is the engine's", view.mode === "when-needed" && cmd.includes(view.invitation.id) && /^\d{6}$/.test((await page.locator(".dlg .ko-code").innerText()).replace(/\D/g, "")),
    "GET /api/devices has the invitation whose id is in the command shown, with its six-digit number");
  const deployment = await api("deployment");
  const note = await page.locator(".dlg-b").innerText();
  await page.screenshot({ path: join(tmpdir(), "verify-setup-another-computer-dialog.png") });
  check("only here: what is missing, and the next step", !deployment.remote.enabled && note.includes("only answers on this computer itself") && (await page.locator('.dlg [data-act="pair-door"]').count()) === 1
    && !(await page.locator('.dlg [data-act="pair-door"]').evaluate((el) => el.classList.contains("soon"))),
    "GET /api/deployment: remote off, so the dialog says the link only answers here and offers Open it to Tailscale (live)");
}

/* Cancel, then Escape: the invitation stops, setup stays open and This computer stays picked. */
async function leaveWithout(page) {
  await page.locator('.dlg [data-act="pair-cancel"]').click();
  check("pair-cancel from setup", await until(async () => (await api("devices")).invitation === null), "GET /api/devices has no invitation on offer");
  check("nothing picked by cancelling", (await page.locator(card("this")).getAttribute("aria-pressed")) === "true" && (await page.locator(REMOTE).getAttribute("aria-pressed")) === "false", "This computer is still the one picked");
  await page.locator(REMOTE).click();
  await page.locator(".dlg .ko-code").waitFor();
  await page.keyboard.press("Escape");
  await wait(300);
  const open = { dlg: await page.locator(".dlg").count(), setup: await page.locator(".ob9").count() };
  check("one Escape closes only the dialog", open.dlg === 0 && open.setup === 1, `after one Escape: ${open.dlg} dialog, ${open.setup} setup`);
  check("Escape cancels the invitation", await until(async () => (await api("devices")).invitation === null), "GET /api/devices has no invitation on offer");
}

/* The stand-in answers the dialog's invitation; the owner compares the codes and lets it in; it dials in. */
async function connect(page, client, dir, stamp) {
  await page.locator(REMOTE).click();
  await page.locator(".dlg .pair-cmd15").waitFor();
  const [, link, code] = /"([^"]+)"\s+(\d{6})/.exec(await page.locator(".dlg .pair-cmd15").innerText()) ?? [];
  const name = `Desk PC ${stamp}`;
  const paired = client.pairNode(dir, link, code, { platform: "linux", offers: [], name, intervalMs: 400 });
  paired.catch(() => {});
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 10000 });
  const identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  const request = (await api("devices")).requests.find((r) => r.name === name);
  const text = await page.locator(".dlg-b").innerText();
  check("waiting for the owner's yes", request?.status === "waiting" && request.check === client.keyCheck(identity.publicKey) && text.includes(request.check) && !(await api("devices")).devices.length,
    `the dialog names ${name} with check code ${request?.check}, the code the other computer shows; nothing is let in yet`);
  check("Let it in waits for the tick", await page.locator('.dlg [data-act="pair-letin"]').isDisabled(), "disabled until The code matches is ticked");
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const done = await paired;
  const device = (await api("devices")).devices.find((d) => d.id === done.deviceId);
  check("pair-letin from setup", device?.name === name && device.enabled.length === 0 && device.connected === false, "GET /api/devices lists it (everything off), not connected yet; the stand-in was told its device id");
  await page.locator(".ob9 .ob-remote").waitFor();
  const picked = await page.locator(REMOTE).evaluate((el) => ({ pressed: el.getAttribute("aria-pressed"), small: el.querySelector("small").textContent }));
  check("that computer is picked", picked.pressed === "true" && picked.small === name && (await page.locator(card("this")).getAttribute("aria-pressed")) === "false", "Another computer is picked and names it");
  const waiting = await page.locator(".ob9 .ob-remote").innerText();
  check("waiting for it to dial in", waiting.includes(name) && waiting.includes("Waiting for the other computer") && waiting.includes("branch node run"), `shown: "${waiting.replace(/\s+/g, " ")}"`);
  return { name, done };
}

async function dialIn(page, client, identity, stamp) {
  const actions = { available: async () => [], prepare: async () => {}, perform: async () => ({ value: null }) };
  const stop = new AbortController();
  const node = new client.NodeClient({ identity, platform: "linux", actions });
  node.run(stop.signal).catch(() => {});
  const shown = await until(async () => (await page.locator(".ob9 .ob-remote").innerText()).includes("Connected now"), 15000);
  const device = (await api("devices")).devices.find((d) => d.id === identity.deviceId);
  check("connected", shown && device?.connected === true, "setup says Connected now once GET /api/devices says connected: true");
  await page.screenshot({ path: join(tmpdir(), "verify-setup-another-computer.png") });
  await page.locator('.ob9 [data-act="ob-next"]').click();
  await page.locator('.ob9[data-step="2"]').waitFor();
  check("setup continues", true, "Continue goes on to Models");
  await page.locator('.ob9 .ob-foot [data-act="ob-go"][data-v="1"]').click(); // Back
  await page.locator('.ob9[data-step="1"]').waitFor();
  check("the choice holds", (await page.locator(REMOTE).getAttribute("aria-pressed")) === "true" && (await page.locator(".ob9 .ob-remote").innerText()).includes("Connected now"), `Back on the step, ${identity.name} is still the one picked, connected`);
  await page.locator(card("this")).click();
  const still = (await api("devices")).devices.find((d) => d.id === identity.deviceId);
  check("This computer can be picked again", (await page.locator(card("this")).getAttribute("aria-pressed")) === "true" && (await page.locator(".ob9 .ob-remote").count()) === 0 && !!still,
    "This computer is picked again; the other computer stays paired (GET /api/devices) and is no longer the choice");
  await page.locator(REMOTE).click();
  check("picking it again needs no second pairing", (await page.locator(REMOTE).getAttribute("aria-pressed")) === "true" && (await page.locator(".dlg").count()) === 0 && (await api("devices")).invitation === null, "no dialog and no new invitation");
  return stop;
}

/* A phone let in later from "Reach it anywhere" (the same pairing code, the phone's dialog) must not become the computer
   picked on "Where Branch runs". The phone stand-in answers with the link and number read off the dialog. */
async function phoneLater(page, computer, stamp) {
  await page.locator('.ob9 .ob-rail [data-act="ob-go"][data-v="5"]').click();
  await page.locator('.ob9[data-step="5"]').waitFor();
  await page.locator('.ob9 [data-act="pair"]').click();
  await page.locator(".dlg .alt12").waitFor();
  const link = await page.locator(".dlg #pair-link").inputValue(); // the Link row's read-only field
  const code = (await page.locator(".dlg #pair-code").innerText()).replace(/\D/g, "");
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const name = `Phone ${stamp}`;
  const res = await fetch(`${BASE}/api/devices/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer: /offer=([a-f0-9]{32})/.exec(link)?.[1], code, name, platform: "ios", publicKey }) });
  if (res.status !== 200) throw new Error(`the phone stand-in could not answer: ${res.status}`);
  await page.locator('.dlg [data-act="ph-paired-dlg"]').click();
  await page.locator('.dlg [data-act="pair-letin"]').waitFor({ timeout: 6000 });
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  const phone = await until(async () => (await api("devices")).devices.find((d) => d.name === name));
  await page.locator('.ob9 .ob-rail [data-act="ob-go"][data-v="1"]').click();
  await page.locator('.ob9[data-step="1"]').waitFor();
  const picked = await page.locator(REMOTE).evaluate((el) => ({ pressed: el.getAttribute("aria-pressed"), small: el.querySelector("small").textContent }));
  check("a phone paired later is not the computer", phone?.platform === "ios" && picked.pressed === "true" && picked.small === computer && (await page.locator(".ob9 .ob-remote").innerText()).includes(computer),
    `GET /api/devices lists ${name}; Where Branch runs still has ${computer} picked`);
}

(async () => {
  const stamp = Date.now().toString(36);
  const node = await import(pathToFileURL(resolve("dist/devices/node/client.js")).href);
  const protocol = await import(pathToFileURL(resolve("dist/devices/protocol.js")).href);
  const client = { pairNode: node.pairNode, NodeClient: node.NodeClient, keyCheck: protocol.keyCheck };
  const dir = mkdtempSync(join(tmpdir(), "verify-setup-node-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let stop = null;
  try {
    await toWhere(page);
    await looks(page);
    await firstOpen(page);
    await leaveWithout(page);
    const { name, done } = await connect(page, client, dir, stamp);
    stop = await dialIn(page, client, done, stamp);
    await phoneLater(page, name, stamp);
  } catch (error) {
    check("script", false, error.message.split("\n")[0]);
    await page.screenshot({ path: join(tmpdir(), "verify-setup-another-computer-failure.png") }).catch(() => {});
  }
  stop?.abort();
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("\n| Action | Result | How it was confirmed |\n|---|---|---|");
  for (const [a, r, h] of results) console.log(`| ${a} | ${r} | ${h} |`);
  console.log(`\npage errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
  process.exit(results.every((r) => r[1] === "PASS") && !errors.length ? 0 : 1);
})();
