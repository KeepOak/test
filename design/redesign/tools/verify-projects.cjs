// Verifies the Projects fold, a project's own page and Settings › General's project rows (places/project.js) against a
// running engine: each control is clicked in the real window and the change is read back from the engine's own GET
// routes (GET /api/projects, GET /api/projects/<id>/conversations, GET /api/sessions). Page errors must be zero.
// Use a fresh engine (nothing to seed):
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-projects.cjs
// Screenshots go to SHOTS (default: the session temp folder).
const { chromium } = require("playwright");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/projects";
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN to the engine's port and session token."); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(action, ok, how) { results.push([action, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${action}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }
const shot = async (page, name) => { await page.waitForTimeout(500); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); }; // after the view's entry animation

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await page.waitForTimeout(1200);
}
async function openFold(page) {
  if ((await page.getAttribute('#side [data-act="projtoggle"]', "aria-expanded")) !== "true") await page.click('#side [data-act="projtoggle"]');
  await page.waitForSelector('#side [data-act="proj-new"]');
}
const projectRow = (id) => `#side [data-act="project"][data-v="${id}"]`;
/* Every row's count against the engine's, and that the rows are exactly the engine's projects. */
async function rowsMatch(page) {
  const got = await api("projects");
  const drawn = await page.$$eval('#side [data-act="project"]', (rows) => rows.map((r) => [r.dataset.v, r.querySelector(".proj-n")?.textContent ?? ""]));
  const want = got.all.map((p) => [p.id, String(got.conversations[p.id] ?? 0)]);
  return JSON.stringify(drawn) === JSON.stringify(want) ? want : null;
}
const live = async (page, sel) => (await page.getAttribute(sel, "aria-disabled")) !== "true";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Every POST /api/projects/active the window makes: opening a project must make none (the prototype only navigates).
  const activePosts = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/projects/active") activePosts.push(r.postData()); });
  const stamp = Date.now().toString(36).slice(-5);
  try {
    await signIn(page);
    // A conversation filed under the default project, made through the engine, so Default has a real count to show.
    const seeded = await api("run", { prompt: `Default project check ${stamp}` });
    // Settings › General on its own, before the fold has read anything: its rows are the engine's, with their counts.
    await page.reload();
    await page.waitForSelector("#side .machine");
    await page.click('#side .owner-row [data-act="view"][data-v="settings"]');
    const own = await until(async () => {
      const got = await api("projects"), n = got.conversations.default ?? 0;
      const row = await page.$eval('#main [data-act="proj-edit"][data-v="default"]', (b) => b.closest(".prow").textContent);
      return row.includes(`${n} conversation`) && n >= 1 ? row : null;
    });
    check("Settings rows on their own", !!own, `Settings › General, opened first, shows "${(own ?? "").trim()}" as GET /api/projects counts`);
    await openFold(page);
    const firstRows = await until(() => rowsMatch(page));
    check("sidebar rows", !!firstRows && firstRows.some(([id, n]) => id === "default" && Number(n) >= 1), `rows ${JSON.stringify(firstRows)} equal GET /api/projects all + conversations`);
    check("Default named by the window", (await page.textContent(projectRow("default"))).includes("Default"), "the engine's built-in project is labelled t(look.badge.default)");
    await shot(page, "01-fold");

    // Open Default: its page lists the seeded conversation, and there is no Remove for it.
    await page.click(projectRow("default"));
    await page.waitForSelector("#main h1");
    const def = await until(async () => (await page.$(`#main [data-act="chat"][data-id="${seeded.sessionId}"]`)) && true);
    check("open project page", !!def && (await page.textContent("#main h1")).includes("Default"), "Default's page lists the conversation GET /api/projects/default/conversations has");
    check("row aria-current", (await page.getAttribute(projectRow("default"), "aria-current")) === "true", "the open project's row is aria-current");
    check("default not removable", !(await page.$('#main [data-act="proj-remove"]')), "Default has no Remove project (src/projects.ts refuses it)");
    await shot(page, "02-default-page");

    // New project from the fold.
    const name = `Garden ${stamp}`;
    await page.click('#side [data-act="proj-new"]');
    await page.fill("#proj-name", name);
    await page.click('.dlg [data-act="proj-create"]');
    const made = await until(async () => (await api("projects")).all.find((p) => p.name === name));
    check("proj-new / proj-create", !!made, `GET /api/projects lists "${name}" as ${made?.id}`);
    await page.waitForFunction((n) => document.querySelector("#main h1")?.textContent === n, name);
    check("opening leaves the active project", (await api("projects")).active.id === "default" && activePosts.length === 0,
      `create opens the page; GET /api/projects active is still default and the window sent ${activePosts.length} POST /api/projects/active`);
    const empty = await until(async () => ((await page.textContent("#main")).includes("No conversations yet") ? true : null));
    const none = (await api(`projects/${made.id}/conversations`)).sessions;
    check("empty state", !!empty && none.length === 0, "an empty project says No conversations yet, and GET says none");
    check("new row count", !!(await until(() => rowsMatch(page))), "the new row shows 0, as GET does");

    // A slow read of one project never holds up another's page: Default's read is held while the new project opens.
    let release, held = false;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/projects/default/conversations", async (route) => { held = true; await gate; await route.continue(); });
    await page.click(projectRow("default"));
    await until(async () => held || null, 5000);
    await page.click(projectRow(made.id));
    await page.waitForFunction((n) => document.querySelector("#main h1")?.textContent === n, name);
    const ownRead = await until(async () => ((await page.textContent("#main .rows")).includes("No conversations yet") ? true : null), 2000);
    release();
    await page.waitForTimeout(1200);
    const leaked = !!(await page.$(`#main [data-act="chat"][data-id="${seeded.sessionId}"]`));
    await page.unroute("**/api/projects/default/conversations");
    check("per-page reads", held && !!ownRead && !leaked && (await page.textContent("#main h1")) === name,
      "with Default's read held, the new project's page still reads and draws its own (empty) list; Default's late answer is not drawn on it");
    await shot(page, "03-new-project");

    // Edit its instructions; they survive a reload.
    const words = `Keep receipts ${stamp}\nAsk before buying`;
    await page.click('#main [data-act="proj-edit"]');
    await page.fill("#proj-text", words);
    await page.click('.dlg [data-act="proj-save"]');
    const saved = await until(async () => (await api("projects")).all.find((p) => p.id === made.id && p.instructions === words));
    check("proj-edit / proj-save", !!saved, "GET /api/projects has the instructions typed");
    const counted = await until(async () => ((await page.textContent("#main .proj-frow small")).includes("2 lines") ? true : null));
    check("line count", !!counted, "the page counts the instructions' real lines");
    await page.waitForTimeout(600);
    await shot(page, "04-instructions");
    await page.reload();
    await page.waitForSelector("#side .machine");
    await openFold(page);
    await page.click(projectRow(made.id));
    await page.waitForFunction((n) => document.querySelector("#main h1")?.textContent === n, name);
    await page.click('#main [data-act="proj-edit"]');
    check("instructions survive a reload", (await page.inputValue("#proj-text")) === words, "after a reload the editor opens on the saved words");
    await page.click('.dlg [data-act="dlg-close"]');

    // A new conversation in the project is filed there.
    const prompt = `Filed under the garden ${stamp}`;
    await page.click('#main [data-act="proj-newconv"]');
    await page.waitForSelector("#prompt");
    await page.fill("#prompt", prompt);
    await page.keyboard.press("Enter");
    const filed = await until(async () => (await api(`projects/${made.id}/conversations`)).sessions.find((s) => s.opening === prompt), 20000);
    const notDefault = !(await api("projects/default/conversations")).sessions.some((s) => s.opening === prompt);
    check("proj-newconv", !!filed && notDefault, `GET /api/projects/${made.id}/conversations has the new conversation; Default does not`);
    check("new conversation makes it active", (await api("projects")).active.id === made.id && activePosts.length === 1,
      `GET /api/projects active is the project, after ${activePosts.length} POST /api/projects/active (New conversation in it only)`);
    check("count follows", !!(await until(() => rowsMatch(page).then((r) => r?.some(([id, n]) => id === made.id && n === "1") && r))), "the row's count becomes 1, as GET says");
    await shot(page, "05-new-conversation");

    // Back on the page it is listed, and Open opens it.
    await page.click(projectRow(made.id));
    const listed = await until(async () => (await page.$(`#main [data-act="chat"][data-id="${filed.sessionId}"]`)) && true);
    check("project conversations", !!listed && (await page.textContent("#main .rows")).includes(prompt), "the page lists the conversation with its title");
    await shot(page, "06-project-with-conversation");
    await page.click(`#main [data-act="chat"][data-id="${filed.sessionId}"]`);
    const opened = await until(async () => ((await page.getAttribute(`#side .row[data-id="${filed.sessionId}"]`, "aria-current")) === "true" ? true : null));
    check("Open", !!opened, "Open opens that conversation (its row is aria-current)");

    // Rename.
    const renamed = `Orchard ${stamp}`;
    await page.click(projectRow(made.id));
    await page.waitForSelector('#main [data-act="proj-rename"]');
    await page.click('#main [data-act="proj-rename"]');
    await page.fill("#proj-name", renamed);
    await page.click('.dlg [data-act="proj-rename-save"]');
    const re = await until(async () => (await api("projects")).all.find((p) => p.id === made.id && p.name === renamed && p.instructions === words));
    check("proj-rename", !!re, "GET /api/projects has the new name, the instructions kept");
    check("rename drawn", (await until(async () => ((await page.textContent("#main h1")) === renamed && (await page.textContent(projectRow(made.id))).includes(renamed)) || null)) === true, "the page and the row show the new name");

    // Settings › General: the same projects with their counts, and Edit opens the same editor.
    await page.click('#side .owner-row [data-act="view"][data-v="settings"]');
    const inSettings = await until(async () => ((await page.textContent("#main")).includes(renamed) ? true : null));
    const settingsRow = await page.$eval(`#main [data-act="proj-edit"][data-v="${made.id}"]`, (b) => b.closest(".prow").textContent);
    check("Settings rows", !!inSettings && settingsRow.includes("1 conversation") && settingsRow.includes("its own instructions"), `Settings › General: "${settingsRow.trim()}"`);
    check("Settings Edit live", await live(page, `#main [data-act="proj-edit"][data-v="${made.id}"]`), "Edit is live, not a toast");
    await page.click(`#main [data-act="proj-edit"][data-v="${made.id}"]`);
    check("Settings Edit opens the editor", (await page.inputValue("#proj-text")) === words, "the editor opens on the project's instructions");
    await page.click('.dlg [data-act="dlg-close"]');
    await shot(page, "07-settings");

    // Remove, confirmed; its conversation stays.
    await openFold(page);
    await page.click(projectRow(made.id));
    await page.waitForSelector('#main [data-act="proj-remove"]');
    await page.click('#main [data-act="proj-remove"]');
    const confirmText = await page.textContent(".dlg");
    check("remove asks first", ["instructions and settings", "secrets saved in it", "stay in your history", "nothing in its folder is deleted"].every((w) => confirmText.includes(w)),
      "the confirmation names what goes (instructions, settings, its secrets) and what stays (conversations, its folder's files)");
    await shot(page, "08-remove-confirm");
    check("nothing removed before yes", (await api("projects")).all.some((p) => p.id === made.id), "the project is still there until confirmed");
    await page.click('.dlg [data-act="proj-remove-yes"]');
    const gone = await until(async () => !(await api("projects")).all.some((p) => p.id === made.id));
    const kept = (await api("sessions?limit=100")).sessions.some((s) => s.sessionId === filed.sessionId);
    check("proj-remove-yes", !!gone && kept, "GET /api/projects no longer lists it; GET /api/sessions still has its conversation");
    check("rows after remove", !!(await until(() => rowsMatch(page))), "the fold matches the engine again");

    // Two windows naming a project at once: the id the window picks is taken just before its request lands, so the engine
    // refuses it (409) and the window reads the projects again and makes the next id; the other project is untouched.
    const clashName = `Clash ${stamp}`;
    let taken = null;
    await page.route("**/api/projects/new", async (route) => {
      if (!taken) { taken = JSON.parse(route.request().postData()).id; await api("projects/new", { id: taken, name: "Made elsewhere" }); }
      await route.continue();
    });
    await openFold(page);
    await page.click('#side [data-act="proj-new"]');
    await page.fill("#proj-name", clashName);
    await page.click('.dlg [data-act="proj-create"]');
    const second = await until(async () => (await api("projects")).all.find((p) => p.name === clashName));
    await page.unroute("**/api/projects/new");
    const other = (await api("projects")).all.find((p) => p.id === taken);
    check("create never replaces", !!second && second.id === `${taken}-2` && other?.name === "Made elsewhere" && (await page.textContent("#main h1")) === clashName,
      `the window's id ${taken} was taken first: refused, then made as ${second?.id}; ${taken} still named "${other?.name}"`);
    for (const id of [taken, second?.id]) if (id) await api(`projects/${id}/remove`, {});

    // Nothing drawn on a project page is greyed: every control there does its real thing.
    await page.click(projectRow("default"));
    await page.waitForSelector('#main [data-act="proj-newconv"]');
    const grey = await page.$$eval('#main [data-act^="proj-"], #main [data-act="chat"], #side [data-act="project"], #side [data-act="proj-new"]', (els) => els.filter((e) => e.getAttribute("aria-disabled") === "true").map((e) => e.dataset.act));
    check("nothing greyed", grey.length === 0, grey.length ? `greyed: ${grey.join(", ")}` : "every project control is live");

    // A household person switched in while a project page is open sees none of it: no name, no conversations.
    const person = await api("profiles", { name: `Sam ${stamp}`, pin: "4321" });
    await page.reload();
    await page.waitForSelector("#side .machine");
    await openFold(page);
    await page.click(projectRow("default"));
    await until(async () => (await page.$(`#main [data-act="chat"][data-id="${seeded.sessionId}"]`)) && true);
    await page.click('#side [data-act="owner"]');
    await page.click(`.pop [data-act="switchto"][data-v="${person.id}"]`);
    await page.fill("#pin-try", "4321");
    await page.click('.dlg [data-act="pin-ok"]');
    // Checked on the draw that follows the switch, before the window reloads for the new person (main.js watchPerson).
    await page.waitForFunction((n) => document.querySelector("#side .owner .who14 b")?.textContent === n, `Sam ${stamp}`);
    const hidden = await page.evaluate((sid) => !document.querySelector(`#main [data-act="chat"][data-id="${sid}"]`) && !document.querySelector('#main [data-act^="proj-"]'), seeded.sessionId);
    const switched = (await api("profiles")).active?.id === person.id;
    await api("profiles/switch", { profileId: null });
    await api(`profiles/${person.id}/remove`, {}); // the person made for this check goes again
    check("household person sees no project", !!switched && !!hidden, "after switching to a household person on Default's page, neither its conversations nor its controls are drawn");
  } finally {
    check("page errors", errors.length === 0, errors.length ? errors.join(" | ") : "none");
    await browser.close();
  }
  for (const [a, r, h] of results) console.log(`${r}  ${a} — ${h}`);
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(failed ? `${failed} failed` : `all ${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
