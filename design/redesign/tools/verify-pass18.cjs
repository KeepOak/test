// Pass 18 (empty states, live lines, room lanes, team board): checks each against the engine's own GET routes.
//   Empty mode, on a fresh data folder:  PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-pass18.cjs empty
//   Filled mode, on a folder seeded by seed-pass18.mjs (engine stopped while seeding):
//                                       PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-pass18.cjs filled
// SHOTS=<dir> also saves 1440 and 390 shots, light and dark.
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, MODE = process.argv[2] ?? "empty", SHOTS = process.env.SHOTS;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const base = `http://127.0.0.1:${PORT}`;
const api = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error}`);
  return data;
};
const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const place = async (page, v) => { await page.locator(`[data-act="view"][data-v="${v}"]`).first().click(); await page.waitForTimeout(700); };
const tab = async (page, v) => { await page.locator(`#main [data-act="ptab"][data-v="${v}"]`).first().click(); await page.waitForTimeout(900); };
const emptyText = (page, root = "#main") => page.locator(`${root} .empty18c p`).first().textContent({ timeout: 4000 }).catch(() => "");
const disabled = (loc) => loc.evaluate((el) => el.disabled || el.getAttribute("aria-disabled") === "true").catch(() => false);

async function shot(page, name) {
  if (!SHOTS) return;
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((s) => { document.documentElement.dataset.theme = s; }, scheme); // the shot only; the look stays saved as it was
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

async function empty(page) {
  const state = await api("state"), teams = (await api("teams")).teams;
  const expect = [
    ["team", "live", "Nobody is working right now.", !(state.runs ?? []).some((r) => r.status === "running" || r.status === "needs_input")],
    ["team", "agents", "No teams yet.", teams.length === 0],
    ["team", "groups", "No groups yet.", ((await api("people/settings")).groups ?? []).length === 0],
    ["team", "activity", "Nothing has happened yet.", true],
    ["inbox", "finished", "Nothing has finished yet.", !(state.runs ?? []).some((r) => r.status === "completed")],
    ["inbox", "history", "No history yet.", (state.runs ?? []).length === 0],
    ["automations", "scheduled", "Nothing runs on a schedule yet.", (state.schedules ?? []).length === 0],
    ["automations", "triggers", "Nothing starts on its own yet.", (state.triggers ?? []).length === 0],
    ["library", "memory", "Nothing to remember yet.", (state.memory ?? []).length === 0],
    ["library", "made", "Nothing made yet.", ((await api("artifacts")).artifacts ?? []).length === 0],
    ["customize", "trunks", "No Trunks yet.", ((await api("trunks")).trunks ?? []).length === 0],
  ];
  for (const [where, v, words, engineEmpty] of expect) {
    await place(page, where);
    await tab(page, v);
    const said = await emptyText(page);
    check(`${where} › ${v}: the engine's list is empty and the welcome says so`, engineEmpty && said.startsWith(words), said);
    if (v === "live") check("empty18c: a line icon, never the mascot (the owner's faces rule)", (await page.locator("#main .empty18c .ico18c svg.i").count()) === 1 && (await page.locator("#main .empty18c :is(img, video)").count()) === 0);
    if (["live", "agents"].includes(v)) await shot(page, `empty-team-${v}`);
  }
  await place(page, "team");
  await tab(page, "agents");
  check("mkteam18c: with no specialists Make a team is greyed (POST /api/teams needs 1-8)", ((await api("state")).specialists ?? []).length === 0 && await disabled(page.locator('#main [data-act="mkteam18c"]')));
  for (const [v, act] of [["people", "invite18c"], ["groups", "group18c"]]) {
    await tab(page, v);
    const btn = page.locator(`#main .empty18c [data-act="${act}"]`);
    check(`${act}: ${v}'s welcome button is held for the security review`, await disabled(btn) && (await btn.getAttribute("data-held").catch(() => null)) === "security");
  }
  await tab(page, "live");
  await page.locator('#main .empty18c [data-act="newconv"]').click();
  await page.waitForTimeout(800);
  check("newconv: Start a conversation opens a new conversation", (await page.locator("#prompt").count()) === 1);
  const pane = page.locator('[data-act="pane"]').first();
  if (!(await page.locator("#pane .pane-b").count())) await pane.click().catch(() => {});
  await page.waitForTimeout(600);
  const paneSaid = await emptyText(page, "#pane");
  check("pane › Activity: an empty conversation's Activity is the welcome", paneSaid.startsWith("Nothing here yet."), paneSaid);
  if (paneSaid) {
    await page.locator('#pane [data-act="ask18c"]').click();
    check("ask18c: Ask something puts the cursor in the message box", await page.evaluate(() => document.activeElement?.id === "prompt"));
    await shot(page, "empty-pane-activity");
  }
}

/* Filled mode's own setup through the API: Trunks and rooms on, two Trunks (one paused) and a room of the two. */
async function setupFilled() {
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "rooms", mode: "on" });
  const run = Date.now().toString(36).slice(-4);
  const a = (await api("trunks", { name: `Lane A ${run}`, title: "Checks the lanes" })).trunk;
  const b = (await api("trunks", { name: `Lane B ${run}`, title: "Checks the lanes" })).trunk;
  await api(`trunks/${b.id}/pause`, {}).catch((error) => console.log(`pause: ${error.message}`));
  await api("trunks/rooms", { name: `Lanes ${run}`, members: [a.id, b.id] });
}

async function filled(page) {
  const trunks = (await api("trunks")).trunks, rooms = (await api("trunks")).rooms;
  const state = await api("state");
  await place(page, "customize");
  await tab(page, "trunks");
  for (const tr of trunks) {
    const line = await page.locator(`#main .prow[data-trunk="${tr.id}"] .live18`).textContent().catch(() => null);
    const want = tr.paused ? "Paused" : "Idle";
    const busy = (state.runs ?? []).some((r) => r.sessionId === tr.chatSessionId && ["running", "needs_input"].includes(r.status));
    check(`live line: ${tr.name} reads the engine's state`, busy ? !!line : line === want, line ?? "");
  }
  await shot(page, "live-lines");

  const room = rooms[0];
  if (room) {
    const view = await api(`trunks/rooms/${room.id}`);
    await page.locator(`#side [data-act="chat"][data-id="${room.sessionId}"]`).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    if (!(await page.locator("#pane .lanes18b").count())) await page.locator('[data-act="pane"]').first().click().catch(() => {});
    await page.waitForTimeout(1200);
    const names = await page.locator("#pane .lanes18b .lane18b b").allTextContents();
    const seats = room.members.map((id) => trunks.find((tr) => tr.id === id)?.name);
    check("lane18b: one lane per member, in the room's seat order", JSON.stringify(names.slice(0, seats.length)) === JSON.stringify(seats), names.join(", "));
    await shot(page, "room-lanes");
    const first = page.locator("#pane [data-act=lane18b]").first();
    const sid = await first.getAttribute("data-id").catch(() => null);
    check("lane18b: a lane names the conversation the room keeps for that member", sid === view.memberSessions?.[room.members[0]], sid ?? "");
    check("lane18b: opening a member's conversation is drawn greyed until the view-only member view exists", await disabled(first));
    if (sid) { await first.click({ force: true }).catch(() => {}); await page.waitForTimeout(800); check("lane18b: pressed, the room stays open (no writable member chat)", (await page.locator("#pane .lanes18b").count()) === 1); }
  }

  const teams = (await api("teams")).teams;
  await place(page, "team");
  await tab(page, "agents");
  const cards = await page.locator("#main .team18b .th18 b").allTextContents();
  check("tboard18b: a card per team from GET /api/teams", JSON.stringify(cards) === JSON.stringify(teams.map((x) => x.name)), cards.join(", "));
  for (const team of teams) {
    const [task] = (await api(`teams/${team.id}/tasks`)).tasks;
    if (!task) continue;
    const head = page.locator(`#main [data-act="tboard18b"][data-id="${team.id}"]`);
    if ((await head.getAttribute("aria-expanded")) !== "true") { await head.click(); await page.waitForTimeout(500); }
    const lanes = await page.locator(`#main .team18b:has([data-id="${team.id}"]) .card18a`).count();
    check(`tboard18b: ${team.name} opens into one lane per member of its newest task`, lanes === task.members.length, `${lanes}/${task.members.length}`);
    if (task.handoff) {
      const acc = page.locator(`#main .team18b:has([data-id="${team.id}"]) [data-act="hoaccept18b"]`);
      const rej = page.locator(`#main .team18b:has([data-id="${team.id}"]) [data-act="horeject18b"]`);
      check("hoaccept18b / horeject18b: drawn held for the security review", await disabled(acc) && await disabled(rej) && (await acc.getAttribute("data-held")) === "security");
    }
    await head.click();
    await page.waitForTimeout(400);
    check(`tboard18b: the header folds ${team.name}`, (await page.locator(`#main .team18b:has([data-id="${team.id}"]) .board18b`).count()) === 0);
    await head.click();
  }
  await shot(page, "team-board");

  /* Make a team through the specialist picker: on this scratch engine the seeded teams go first, so the tab is empty. */
  for (const team of teams) await api(`teams/${team.id}/remove`, {});
  await tab(page, "live");
  await tab(page, "agents");
  const make = page.locator('#main .empty18c [data-act="mkteam18c"]');
  check("mkteam18c: with specialists Make a team is live", (await make.count()) === 1 && !(await disabled(make)));
  await make.click();
  await page.waitForTimeout(500);
  const chips = page.locator('[data-act="mkpick18c"]');
  const specs = (await api("state")).specialists ?? [];
  check("mkpick18c: the picker lists the engine's specialists", (await chips.count()) === specs.length, `${await chips.count()}/${specs.length}`);
  const picked = [await chips.nth(0).getAttribute("data-v"), await chips.nth(1).getAttribute("data-v")];
  await chips.nth(0).click();
  await chips.nth(1).click();
  const name = `Made ${Date.now().toString(36).slice(-4)}`;
  await page.locator("#mkteam-name").fill(name);
  await page.locator('[data-act="mksave18c"]').click();
  await page.waitForTimeout(1500);
  const made = (await api("teams")).teams.find((x) => x.name === name);
  check("mksave18c: GET /api/teams has the new team with the two picked specialists", !!made && JSON.stringify(made.members.map((m) => m.specialistId)) === JSON.stringify(picked), made ? made.members.map((m) => m.role).join(", ") : "none");
  check("mksave18c: Team › Teams of specialists shows it", (await page.locator("#main .team18b .th18 b").allTextContents()).includes(name));
  await shot(page, "team-made");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    if (MODE === "filled") await setupFilled();
    await page.goto(base);
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.waitForTimeout(1200);
    if (MODE === "empty") await empty(page); else await filled(page);
  } catch (error) {
    check("run finished", false, error.message.split("\n")[0]);
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
