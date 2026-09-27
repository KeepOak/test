/* Q258: the window still draws for a household person now that GET /api/state sends them none of the owner's records
   or settings. Against a fresh throwaway engine: the owner writes instructions for the assistant and adds a project,
   adds Sam and switches the window to him; the engine's GET /api/state as Sam holds neither, has the owner's keys
   with empty values, and the window opens every place and Settings with no page error. It switches back to the owner.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-q258-household.cjs */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
if (PORT === "3210") { console.error("Never the owner's app."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const MARK = "q258verifycanary";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function call(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function ownerSeeds() {
  const identity = (await call("state")).body.identity;
  const saved = await call("identity", { name: identity.name, instructions: `${MARK} instructions`, expectedRevision: identity.revision });
  check("the owner's instructions for the assistant are saved", saved.status === 200 && saved.body.instructions === `${MARK} instructions`, String(saved.status));
  const project = await call("projects", { id: `${MARK}-project`, name: `${MARK} project` });
  check("the owner's project is saved", project.status === 200, `${project.status} ${JSON.stringify(project.body).slice(0, 120)}`);
  const ownerState = JSON.stringify((await call("state")).body);
  check("control: the owner's GET /api/state holds both", ownerState.includes(`${MARK} instructions`) && ownerState.includes(`${MARK}-project`));
  // A run again finds Sam already there.
  const known = (await call("profiles")).body.profiles?.find((profile) => profile.name === "Sam");
  const sam = known ? { status: 200, body: known } : await call("profiles", { name: "Sam", pin: "2468" });
  check("Sam is on this computer", sam.status === 200 && sam.body.id, String(sam.status));
  const switched = await call("profiles/switch", { profileId: sam.body.id, pin: "2468" });
  check("the window is switched to Sam", switched.status === 200 && switched.body.active?.id === sam.body.id, String(switched.status));
  return Object.keys(JSON.parse(ownerState));
}

async function samsState(ownerKeys) {
  const state = (await call("state")).body;
  const text = JSON.stringify(state);
  check("GET /api/state as Sam holds nothing of the owner's", !text.includes(MARK));
  check("the same keys as the owner's", JSON.stringify(Object.keys(state).sort()) === JSON.stringify(ownerKeys.sort()));
  check("owner-only values are empty", state.workspace === null && state.identity.instructions === "" && state.project.all.length === 0 && state.approvalCategories.length === 0);
}

async function windowDraws() {
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
  for (const place of ["overview", "inbox", "automations", "library", "team", "customize", "settings"]) {
    const button = page.locator(`[data-act="view"][data-v="${place}"]`).first();
    if (!(await button.count())) { check(`${place}: its button is drawn`, false); continue; }
    await button.click();
    await page.waitForTimeout(900);
    const drawn = await page.locator("#main").innerText().catch(() => "");
    check(`${place} draws for Sam`, drawn.trim().length > 0 && !drawn.includes(MARK), `${drawn.trim().length} characters`);
  }
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
  await browser.close();
}

(async () => {
  const ownerKeys = await ownerSeeds();
  try {
    await samsState(ownerKeys);
    await windowDraws();
  } finally {
    const back = await call("profiles/switch", { profileId: null });
    check("switched back to the owner", back.status === 200 && back.body.active === null, String(back.status));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
