/* Q259: the window still works for a household person now that commands, GET /api/policy and the reads around them
   answer for them only. Against a fresh throwaway engine: the owner switches typed commands on, adds Sam and switches
   the window to him. As Sam the engine sends no policy and no approval categories, refuses the pairing link, and
   refuses /skills typed at the window; the window then sends /skills and /status from the message box (the engine's
   answers are read off the network), opens every place with no page error, and switches back to the owner.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-q259-household.cjs */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
if (PORT === "3210") { console.error("Never the owner's app."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const REFUSAL = "This belongs to the owner. Switch back to the owner's profile to use it.";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function call(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function toSam() {
  const mode = (await call("commands/settings")).body.mode;
  check("typed commands are switched on", (await call("commands/settings", { mode: "on" })).status === 200);
  const owner = await call("policy");
  check("control: the owner reads the policy", owner.status === 200 && owner.body.policy && Array.isArray(owner.body.policy.rules));
  const known = (await call("profiles")).body.profiles?.find((profile) => profile.name === "Sam");
  const sam = known ? { status: 200, body: known } : await call("profiles", { name: "Sam", pin: "2468" });
  check("Sam is on this computer", sam.status === 200 && sam.body.id, String(sam.status));
  const switched = await call("profiles/switch", { profileId: sam.body.id, pin: "2468" });
  check("the window is switched to Sam", switched.status === 200 && switched.body.active?.id === sam.body.id, String(switched.status));
  return mode;
}

async function samsReads() {
  const policy = await call("policy");
  check("GET /api/policy as Sam: no policy, the presets and his waiting list", policy.status === 200 && policy.body.policy === null
    && Array.isArray(policy.body.presets) && Array.isArray(policy.body.waiting));
  check("GET /api/approvals/categories as Sam: none", JSON.stringify((await call("approvals/categories")).body.categories) === "[]");
  const pairing = await call("agents/pairing");
  check("GET /api/agents/pairing as Sam is refused", pairing.status === 400 && pairing.body.error === REFUSAL, String(pairing.status));
  const skills = await call("commands/run", { surface: "window", line: "/skills" });
  check("/skills from the window as Sam is refused", skills.body.refused === true && skills.body.text === REFUSAL, JSON.stringify(skills.body).slice(0, 120));
}

/** Types a command into the message box and returns the engine's answer to it, read off the network. */
async function typed(page, line) {
  const box = page.locator("#prompt").first();
  await box.click();
  await box.fill(line);
  const answer = page.waitForResponse((response) => response.url().endsWith("/api/commands/run"), { timeout: 8000 });
  // The send button, as a person clicks it: with a "/" line the slash menu answers Enter itself.
  await page.locator("#send").first().click();
  return (await answer).json();
}

async function windowWorks() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForTimeout(2000);
  // A fresh engine has not been set up, so the window offers setup first; it is closed as a person would.
  if (await page.locator('.ob9 [data-act="ob-close"]').count()) { await page.locator('.ob9 [data-act="ob-close"]').first().click(); await page.waitForTimeout(500); }
  check("the window opens on Sam", (await page.locator(".owner .who14 b").first().innerText().catch(() => "")) === "Sam");
  const chat = page.locator('[data-act="view"][data-v="chat"]').first();
  if (await chat.count()) { await chat.click(); await page.waitForTimeout(600); }
  const skills = await typed(page, "/skills").catch((error) => ({ error: error.message }));
  check("the message box's /skills is refused by the engine", skills.refused === true && skills.text === REFUSAL, JSON.stringify(skills).slice(0, 160));
  const status = await typed(page, "/status").catch((error) => ({ error: error.message }));
  check("the message box's /status answers Sam without the owner's approval setting",
    typeof status.text === "string" && status.refused === undefined && !status.text.includes("When to check with you"), JSON.stringify(status).slice(0, 160));
  for (const place of ["overview", "inbox", "automations", "library", "team", "customize", "settings"]) {
    const button = page.locator(`[data-act="view"][data-v="${place}"]`).first();
    if (!(await button.count())) { check(`${place}: its button is drawn`, false); continue; }
    await button.click();
    await page.waitForTimeout(900);
    const drawn = await page.locator("#main").innerText().catch(() => "");
    check(`${place} draws for Sam`, drawn.trim().length > 0, `${drawn.trim().length} characters`);
  }
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
  await browser.close();
}

(async () => {
  const mode = await toSam();
  try {
    await samsReads();
    await windowWorks();
  } finally {
    const back = await call("profiles/switch", { profileId: null });
    check("switched back to the owner", back.status === 200 && back.body.active === null, String(back.status));
    if (mode) await call("commands/settings", { mode });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
