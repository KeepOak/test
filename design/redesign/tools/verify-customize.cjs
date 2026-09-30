// Clicks every Customize control made live in this area and checks each change through the engine's own GET route.
// Run against a fresh engine: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-customize.cjs
// Setup through the API (not window controls): Trunks, rooms and the prompt library are switched on (all start off),
// two Trunks are made, and one saved recipe is proposed so Automations › Procedures has a row to open.
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const base = `http://127.0.0.1:${PORT}`;
const api = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error}`);
  return data;
};
const RUN = Date.now().toString(36).slice(-5); // names are unique per run, so the script can be run again
const N = { a: `Verify A ${RUN}`, a2: `Verify A2 ${RUN}`, b: `Verify B ${RUN}`, room: `Verify room ${RUN}`, skill: `verify-skill-${RUN}`, cmd: `verify-${RUN}`, recipe: `Verify recipe ${RUN}` };
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const trunks = async () => (await api("trunks")).trunks;
const rooms = async () => (await api("trunks")).rooms;
const trunkNamed = async (name) => (await trunks()).find((t) => t.name === name);
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 200)); } }
const disabled = async (loc) => (await loc.getAttribute("aria-disabled")) === "true" || (await loc.isDisabled());

async function setup() {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "rooms", mode: "on" });
  await api("prompts/settings", { mode: "on" });
  for (const name of [N.a, N.b]) await api("trunks", { name, title: "Checks the window" });
  await api("action", { tool: "procedures.propose", args: { name: N.recipe, preconditions: [], steps: [{ tool: "memory.search", args: { query: "invoice" }, expected: {} }] } });
}

async function editor(page) {
  const a = await trunkNamed(N.a);
  await page.locator(`#main [data-act="edit"][data-id="${a.id}"]`).click();
  const dlg = page.locator(".dlg");
  await dlg.locator('[data-act="st-shape"][data-v="4"]').click();
  await dlg.locator('[data-act="emo15"][data-v="🐢"]').click();
  await page.waitForTimeout(400);
  await dlg.locator('.dlg-f [data-act="dlg-close"]').click();
  let t = await trunkNamed(N.a);
  check("emo15 saves only the face: an unsaved shape is not saved with it", t.look?.face === "emoji" && t.look?.emoji === "🐢" && t.look?.shape === null, JSON.stringify(t.look));
  await page.locator(`#main [data-act="edit"][data-id="${a.id}"]`).click();
  await dlg.locator('[data-act="st-shuffle"]').click();
  await dlg.locator('[data-act="st-colour"][data-v="#D8612A"]').click();
  await dlg.locator('[data-act="st-shape"][data-v="2"]').click();
  await dlg.locator('[data-act="st-anim"][data-v="sway"]').click();
  await dlg.locator('[data-act="st-tab"][data-v="may"]').click();
  check("st-tab: What it may do draws its switches greyed", await disabled(dlg.locator("#tm-read")));
  await dlg.locator('[data-act="st-tab"][data-v="look"]').click();
  await dlg.locator('[data-act="emo15"][data-v="🦊"]').click();
  await page.waitForTimeout(400);
  t = await trunkNamed(N.a);
  check("emo15: the emoji face is saved at once", t.look?.face === "emoji" && t.look?.emoji === "🦊", JSON.stringify(t.look));
  await dlg.locator("#st-name").fill(N.a2);
  await dlg.locator("#st-role").fill("Checks the editor");
  await dlg.locator('[data-act="st-save"]').click();
  await page.waitForTimeout(500);
  t = (await trunks()).find((x) => x.id === a.id);
  check("st-save / st-colour / st-shape / st-anim / st-shuffle: saved through POST /api/trunks/{id}",
    t.name === N.a2 && t.title === "Checks the editor" && t.chosenColour === "#d8612a" && t.look?.shape === "leaf" && t.look?.motion === "sway" && t.look?.face === "emoji",
    JSON.stringify({ name: t.name, title: t.title, chosenColour: t.chosenColour, look: t.look }));
  await page.locator(`#main [data-act="edit"][data-id="${a.id}"]`).click();
  await page.locator('.dlg [data-act="emo15"][data-v=""]').click();
  await page.waitForTimeout(400);
  t = (await trunks()).find((x) => x.id === a.id);
  check("emo15 None: back to the face made from the name, shape and colour kept", t.look?.face === "pattern" && t.look?.emoji === "" && t.look?.shape === "leaf", JSON.stringify(t.look));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function menu(page, act) {
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator(`.pop [data-act="${act}"]`).click();
}

async function trunkMenu(page) {
  await page.locator('#main [data-act="tmpl"][data-i="2"]').click();
  await page.waitForTimeout(800);
  let t = (await trunks()).filter((x) => x.name === "Researcher").sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
  const id = t?.id;
  check("tmpl: a Trunk from a job, with the job's colour and shape", !!t && t.chosenColour === "#2f8c86" && t.look?.shape === "pebble", JSON.stringify(t && { chosenColour: t.chosenColour, look: t.look }));
  await menu(page, "pin");
  await page.waitForTimeout(400);
  check("pin: the Trunk is pinned", (await trunks()).find((x) => x.id === id)?.pinned === true);
  await menu(page, "rename");
  await page.locator("#rn-name").fill(`Researcher ${RUN}`);
  await page.locator('.dlg [data-act="rename-save"]').click();
  await page.waitForTimeout(400);
  t = await trunkNamed(`Researcher ${RUN}`);
  check("rename: the Trunk has its new name", !!t);
  await menu(page, "remove");
  await page.locator('.dlg [data-act="trunk-remove-yes"]').click();
  await page.waitForTimeout(500);
  check("remove: POST /api/trunks/{id}/remove took it away", !(await trunks()).some((x) => x.id === t.id));
}

async function room(page) {
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="grp-new"]').click();
  const [a, b] = [await trunkNamed(N.a2), await trunkNamed(N.b)];
  await page.locator(`.dlg [data-act="grp-pick"][data-v="${a.id}"]`).click();
  await page.locator(`.dlg [data-act="grp-pick"][data-v="${b.id}"]`).click();
  await page.locator("#grp-name").fill(N.room);
  await page.locator('.dlg [data-act="grp-make"]').click();
  await page.waitForTimeout(800);
  const r = (await rooms()).find((x) => x.name === N.room);
  check("grp-new / grp-pick / grp-make: the room exists with both Trunks", !!r && r.members.includes(a.id) && r.members.includes(b.id), JSON.stringify(r && r.members));
  await menu(page, "pin");
  await page.waitForTimeout(400);
  check("pin (room): the room is pinned", (await rooms()).find((x) => x.name === N.room)?.pinned === true);
  await menu(page, "rename");
  await page.locator("#rn-name").fill(`${N.room} renamed`);
  await page.locator('.dlg [data-act="rename-save"]').click();
  await page.waitForTimeout(400);
  check("rename (room): POST /api/trunks/rooms/{id} renamed it", (await rooms()).some((x) => x.name === `${N.room} renamed`));
}

async function tools(page) {
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="tools"]').click();
  await page.locator('#main [data-act="t9-kind"][data-v="skills"]').click();
  await page.locator('#main [data-act="tool-add"][data-v="skills"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('.dlg [data-act="sk-src"]').click();
  await (await chooser).setFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(`---\nname: ${N.skill}\ndescription: Checks the Add a skill dialog.\n---\n\n1. Read the task.\n`)});
  // The install and the list's redraw take their time on a busy machine: read back until it is there (up to 10 s).
  const skill = await until(async () => (await api("state")).skills.find((s) => s.name === N.skill));
  check("sk-src (file): POST /api/skills/install added the skill", !!skill);
  check("tool-who stays greyed", await disabled(page.locator('#main [data-act="tool-who"]').first()));
  await page.locator(`#main [data-act="t9-sel"][data-v="${skill.id}"]`).click();
  await page.locator(`#main [data-act="tool-rm"][data-id="${skill.id}"]`).click();
  check("tool-rm: the skill is removed", await until(async () => !(await api("state")).skills.some((s) => s.id === skill.id)));
  await page.locator('#main [data-act="t9-kind"][data-v="mcp"]').click();
  await page.locator('#main [data-act="tool-add"][data-v="mcp"]').click();
  await page.locator('.dlg [data-act="t9-own"]').click();
  check("t9-own opens Add your own MCP server; Test it stays greyed", (await page.locator(".dlg h2").innerText()) === "Add your own MCP server" && await disabled(page.locator('.dlg [data-act="mcp-test"]')));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function channels(page) {
  await page.locator('#main [data-act="ptab"][data-v="channels"]').click();
  await page.waitForTimeout(600);
  const core = (await api("channel-setup")).channels.filter((c) => c.family === "core").length;
  await page.locator('#main [data-act="ch-fam"][data-v="core"]').click();
  const shown = await page.locator("#main .ch12").count();
  check("ch-fam: Popular shows the engine's popular chat apps", shown === core && core > 0, `${shown} of ${core}`);
}

async function automations(page) {
  await page.locator('[data-act="view"][data-v="automations"]').click();
  await page.locator('#main [data-act="ptab"][data-v="procedures"]').click();
  await page.waitForTimeout(600);
  await page.locator('#main [data-act="prompt-new"]').click();
  await page.locator("#pr-name").fill("Verify prompt");
  await page.locator("#pr-cmd").fill(N.cmd);
  await page.locator("#pr-text").fill("Summarise {{topic}} for me");
  await page.locator('.dlg [data-act="prompt-save"]').click();
  await page.waitForTimeout(500);
  check("prompt-new / prompt-save: POST /api/prompts saved it", (await api("prompts")).prompts.some((p) => p.command === N.cmd && p.title === "Verify prompt"));
  const recipe = (await api("state")).procedures.find((p) => p.data?.definition?.name === N.recipe);
  await page.locator(`#main [data-act="flow"][data-id="${recipe.id}"]`).click();
  const dlg = page.locator(".dlg");
  // finish-soon-a: a recipe's steps move and come out (Save is live); no route runs a recipe, so its Run is drawn greyed.
  const run = dlg.locator(".btn.soon", { hasText: "Run" });
  check("flow: opens the recipe's real steps; Save is live and Run is greyed", (await dlg.locator("h2").innerText()) === N.recipe && (await dlg.locator("#ft-0").inputValue()).startsWith("memory.search") && !(await disabled(dlg.locator('[data-act="flow-save"]'))) && (await run.count()) === 1 && (await disabled(run)) && (await dlg.locator('[data-act="flow-run"]').count()) === 0);
  await dlg.locator('[data-act="dlg-close"]').first().click();
}

async function computers(page) {
  await page.locator('[data-act="machines"]').first().click();
  await page.locator('.pop [data-act="addcomp"]').click();
  await page.locator('.dlg [data-act="ac-tab"][data-v="phone"]').click();
  check("addcomp / ac-tab: Add a computer or phone opens and switches tabs", (await page.locator('.dlg [data-act="ac-tab"][aria-selected="true"]').innerText()) === "Your phone");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator('[data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  await page.locator('#main [data-act="comp-add"]').click();
  // unhold-pairing: "Another computer with Branch" pairs for real now (verify-unhold-pairing.cjs); the other kinds stay greyed.
  check("comp-add: Add a computer opens; pairing is live and the other kinds stay greyed", (await page.locator(".dlg h2").innerText()) === "Add a computer"
    && await disabled(page.locator('.dlg [data-act="comp-add-go"][data-v="sandbox"]')) && !(await disabled(page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]'))));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

(async () => {
  await setup();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
    await page.goto(base);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('[data-act="view"][data-v="customize"]').click();
    await editor(page);
    await trunkMenu(page);
    await room(page);
    await tools(page);
    await channels(page);
    await automations(page);
    await computers(page);
  } catch (error) {
    check("run finished", false, error.message);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
