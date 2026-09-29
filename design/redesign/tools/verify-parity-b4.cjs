// Clicks every control parity B4 (Team and Customize) made live and checks each change through the engine's own GET route.
// Seed a fresh data folder first (engine stopped), then start the engine on it:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<ws> node design/redesign/tools/seed-parity-b4.mjs
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<ws> BRANCH_PORT=<port> node dist/cli.js start
//   PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-parity-b4.cjs
// It removes the seeded assistant, so seed a fresh folder for each run.
// Setup through the API (not window controls): Trunks and rooms switched on, two Trunks, a person on this computer, a
// skill, a copy link to stop. Everything else is done by clicking the window.
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
const RUN = Date.now().toString(36).slice(-5);
const N = { a: `Verify A ${RUN}`, b: `Verify B ${RUN}`, room: `Verify room ${RUN}`, person: `Robin ${RUN}`, group: `Verify group ${RUN}`, skill: `verify-b4-${RUN}` };
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const card = () => api("people/settings");
const rooms = async () => (await api("trunks")).rooms;
const S = {};

async function setup() {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "rooms", mode: "on" });
  S.a = (await api("trunks", { name: N.a, title: "Checks the window" })).trunk;
  S.b = (await api("trunks", { name: N.b, title: "Checks the window" })).trunk;
  S.person = await api("profiles", { name: N.person, pin: "482913", role: "adult" });
  S.skill = await api("skills/install", { document: `---\nname: ${N.skill}\ndescription: Checks the SKILL.md preview\n---\n\n# ${N.skill}\n\n1. Read the page.\n` });
  S.seed = (await api("state")).runs.find((r) => r.prompt === "Seed conversation to share");
  S.link = await api(`sessions/${S.seed.sessionId}/share`, { title: `Verify link ${RUN}`, expiresInMinutes: 60 });
}

const tab = (page, v) => page.locator(`#main [data-act="ptab"][data-v="${v}"]`).click();
const place = (page, v) => page.locator(`[data-act="view"][data-v="${v}"]`).click();
async function openChat(page, name) {
  await page.locator(`#side [data-act="chat"]:has-text("${name}")`).first().click();
  await page.waitForTimeout(600);
}

async function team(page) {
  await place(page, "team");
  await page.waitForTimeout(800);
  const asking = (await api("state")).runs.find((r) => r.status === "needs_input");
  await page.locator(`#main [data-act="run-watch"][data-id="${asking.id}"]`).click();
  await page.locator("#stage7").waitFor({ timeout: 8000 });
  check("run-watch: Watch opens the waiting task's conversation with its stage (chat/stage.js)", (await page.locator("#stage7").count()) === 1);
  await page.locator("#stage7 .st7-back").click();
  await place(page, "team");
  await page.waitForTimeout(800);

  await tab(page, "groups");
  await page.locator('#main [data-act="tgrp-new"]').click();
  await page.locator("#tgrp-name").fill(N.group);
  await page.locator(`.dlg [data-act="tgrp-pick"][data-k="members"][data-v="${S.person.id}"]`).click();
  await page.locator('.dlg [data-act="tgrp-pick"][data-k="categories"][data-v="spend"]').click();
  await page.locator("#tgrp-spend").fill("5");
  await page.locator('.dlg [data-act="tgrp-save"]').click();
  await page.waitForTimeout(800);
  let g = (await card()).groups.find((x) => x.name === N.group);
  check("tgrp-new / tgrp-pick / tgrp-save: the group is saved whole (POST /api/people/groups)",
    !!g && g.members.includes(S.person.id) && !g.categories.includes("spend") && g.dailySpendLimit === 5, JSON.stringify(g));
  await page.locator(`#main [data-act="tgrp-edit"][data-id="${g.id}"]`).click();
  await page.locator("#tgrp-name").fill(`${N.group} 2`);
  await page.locator('.dlg [data-act="tgrp-save"]').click();
  await page.waitForTimeout(800);
  g = (await card()).groups.find((x) => x.id === g.id);
  check("tgrp-edit: the same group is saved under its new name, members kept", g?.name === `${N.group} 2` && g.members.includes(S.person.id), JSON.stringify(g));
  await page.locator(`#main [data-act="tgrp-edit"][data-id="${g.id}"]`).click();
  await page.locator(`.dlg [data-act="tgrp-rm"][data-id="${g.id}"]`).click();
  await page.waitForTimeout(800);
  check("tgrp-rm: the group is removed (POST /api/people/groups/<id>/remove)", !(await card()).groups.some((x) => x.id === g.id));

  await tab(page, "shared");
  await page.waitForTimeout(800);
  const listed = (await api("shares")).shares.some((x) => x.id === S.link.id);
  await page.locator(`#main [data-act="tsh-stop"][data-id="${S.link.id}"]`).click();
  await page.waitForTimeout(800);
  const gone = !(await api("shares")).shares.some((x) => x.id === S.link.id);
  check("tsh-stop: the copy link is stopped (POST /api/shares/<id>/revoke deletes it)", listed && gone);
}

async function share(page) {
  await openChat(page, N.a);
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="share10"][data-k="conv"]').click();
  const subject = `profile:${S.person.id}`, object = `conversation:${S.a.chatSessionId}`;
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="driver"]`).click();
  await page.waitForTimeout(700);
  let held = (await card()).shares.filter((x) => x.object === object && x.subject === subject);
  check("share10 / share-rel: May also write in it is saved (POST /api/people/shares)", held.length === 1 && held[0].relation === "driver", JSON.stringify(held));
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="viewer"]`).click();
  await page.waitForTimeout(700);
  held = (await card()).shares.filter((x) => x.object === object && x.subject === subject);
  check("share-rel: May read it replaces it, one share kept", held.length === 1 && held[0].relation === "viewer", JSON.stringify(held));
  await page.locator('.dlg [data-act="share-tab"][data-v="copy"]').click();
  check("share-tab: A copy is drawn, its Make the link greyed", (await page.locator('.dlg [data-act="share-link"]').getAttribute("aria-disabled")) === "true");
  await page.locator('.dlg [data-act="share-tab"][data-v="people"]').click();
  await page.locator(`.dlg [data-act="share-rel"][data-subject="${subject}"][data-v="no"]`).click();
  await page.waitForTimeout(700);
  held = (await card()).shares.filter((x) => x.object === object && x.subject === subject);
  check("share-rel No: the exact share is taken back (POST /api/people/shares/remove)", held.length === 0, JSON.stringify(held));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();

  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="share10"][data-k="trunk"]').click();
  await page.locator('.dlg [data-act="share-tab"][data-v="file"]').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator('.dlg [data-act="share-file"]').click()]);
  const file = JSON.parse(require("node:fs").readFileSync(await download.path(), "utf8"));
  const engine = await api(`trunks/${S.a.id}/export`);
  check("share-file: the engine's file of the Trunk is saved (GET /api/trunks/<id>/export)",
    download.suggestedFilename() === `${N.a}.branch-trunk` && file.format === engine.format && file.trunk.name === N.a && !("keys" in file.trunk) && !("reach" in file.trunk), download.suggestedFilename());
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function roomRules(page) {
  await place(page, "customize");
  await page.locator('#main [data-act="grp-new"]').click();
  await page.locator("#grp-name").fill(N.room);
  await page.locator(`.dlg [data-act="grp-pick"][data-v="${S.a.id}"]`).click();
  await page.locator(`.dlg [data-act="grp-pick"][data-v="${S.b.id}"]`).click();
  await page.locator(`.dlg [data-act="grp-person"][data-v="${S.person.id}"]`).click();
  await page.locator('.dlg [data-act="grp-make"]').click();
  await page.waitForTimeout(1200);
  let room = (await rooms()).find((r) => r.name === N.room);
  check("grp-person / grp-make: the room seats the person on this computer (POST /api/trunks/rooms)", !!room && room.people.includes(S.person.id) && room.members.length === 2, JSON.stringify(room && { people: room.people, members: room.members }));
  await openChat(page, N.room);
  const menuRule = async () => { await page.locator('[data-act="chatmenu"]').first().click(); const words = await page.locator('.pop [data-act="room-rules"] .r').textContent(); await page.locator('.pop [data-act="room-rules"]').click(); return words; };
  const before = await menuRule();
  await page.locator('.pop [data-act="room-rule"][data-v="all"]').click();
  await page.waitForTimeout(800);
  room = (await rooms()).find((r) => r.id === room.id);
  check("room-rule: Everyone, every time is saved (POST /api/trunks/rooms/<id> rule)", room.rule === "all", room.rule);
  const after = await menuRule();
  check("room-rules: the menu row names the room's rule", before !== after && after.length > 0, `${before} → ${after}`);
  await page.locator('.pop [data-act="room-pat"][data-v="router"]').click();
  await page.waitForTimeout(800);
  room = (await rooms()).find((r) => r.id === room.id);
  check("room-pat: Router is saved for this room (pattern)", room.pattern === "router", room.pattern);
  await menuRule();
  await page.locator('.pop [data-act="room-pat"][data-v="default"]').click();
  await page.waitForTimeout(800);
  room = (await rooms()).find((r) => r.id === room.id);
  check("room-pat default: the room follows the owner's default again (pattern null)", room.pattern === null, String(room.pattern));
  await menuRule();
  check("room-pat-teams: Teams is drawn greyed", (await page.locator('.pop [data-act="room-pat-teams"]').getAttribute("aria-disabled")) === "true");
  await page.keyboard.press("Escape");
}

async function tools(page) {
  await place(page, "customize");
  await tab(page, "tools");
  await page.locator('#main [data-act="t9-kind"][data-v="skills"]').click();
  await page.locator(`#main [data-act="t9-sel"][data-v="${S.skill.id}"]`).click();
  await page.waitForTimeout(1000);
  const doc = (await api(`skills/${S.skill.id}`)).document;
  const shown = await page.locator("#main .t9-detail pre.diff6").textContent();
  check("t9-sel: a skill shows its own SKILL.md (GET /api/skills/<id>)", shown === doc, `${shown?.length} chars`);

  await page.locator('#main [data-act="t9-kind"][data-v="agents"]').click();
  await page.waitForTimeout(600);
  const [agent] = (await api("agents/remote")).agents;
  if (!agent) { check("agents: the seeded outside assistant is listed (seed a fresh folder for each run)", false); return; }
  await page.locator(`#main [data-act="t9-sel"][data-v="${agent.id}"]`).click();
  const asked = await page.locator("#main .t9-detail code").allTextContents();
  check("agents: what it may be asked is its card's own skills", JSON.stringify(asked) === JSON.stringify(agent.skills), JSON.stringify(asked));

  await page.locator('#main [data-act="tool-add"][data-v="agents"]').click();
  await page.locator('.dlg [data-act="ag-add"]').click();
  await page.locator("#ag-card").fill(`http://127.0.0.1:${PORT}`);
  await page.locator('.dlg [data-act="ag-go"]').click();
  const toast = await page.locator(".toast").last().textContent({ timeout: 8000 });
  const count = (await api("agents/remote")).agents.length;
  check("ag-add / ag-go: the address goes to POST /api/agents/remote; a local one is refused in the engine's words, nothing added", /private or local address/.test(toast) && count === 1, toast);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();

  await page.locator(`#main [data-act="t9-sel"][data-v="${agent.id}"]`).click();
  await page.locator(`#main [data-act="tool-rm"][data-k="agents"][data-id="${agent.id}"]`).click();
  await page.waitForTimeout(800);
  check("tool-rm: another assistant is removed (POST /api/agents/remote/remove)", (await api("agents/remote")).agents.length === 0);
}

(async () => {
  await setup();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(base);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await team(page);
    await share(page);
    await roomRules(page);
    await tools(page);
  } catch (error) {
    check("run finished", false, error.message.split("\n")[0]);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
