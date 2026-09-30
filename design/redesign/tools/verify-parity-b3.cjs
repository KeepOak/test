/* Parity batch B3 (Inbox, Library, Automations), proved in the real window with real mouse clicks, as a brand-new user
   and as a set-up user, each change read back through the engine's own GET route. Page errors must be zero.
   One engine at a time, on one port; PHASE picks which user (both need a passing run):
     Set-up user:  BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-parity-b3.mjs
                   BRANCH_DATA_DIR=<same> BRANCH_WORKSPACE=<same> BRANCH_PORT=<port> node dist/cli.js start
                   PHASE=setup PORT=<port> TOKEN=<hex> DATA=<same data dir> node design/redesign/tools/verify-parity-b3.cjs
     Brand-new:    BRANCH_DATA_DIR=<empty dir> BRANCH_PORT=<port> node dist/cli.js start
                   PHASE=fresh PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-parity-b3.cjs
   Screenshots go to SHOTS (default: the session folder). */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const { PORT, TOKEN, DATA, PHASE } = process.env;
if (!PORT || !TOKEN || !["setup", "fresh"].includes(PHASE) || (PHASE === "setup" && !DATA)) { console.error("Set PHASE (setup or fresh), PORT, TOKEN, and DATA for setup."); process.exit(2); }
const SHOTS = process.env.SHOTS ?? "C:/Users/bishi/AppData/Local/Temp/claude-session-files/parity-b3";
const NOTE = PHASE === "setup" ? JSON.parse(fs.readFileSync(path.join(DATA, "verify-parity-b3.json"), "utf8")) : {};
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = (port, token) => async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
};
const api = engine(PORT, TOKEN);
const fresh = api;
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await sleep(200); } }
const live = async (loc) => (await loc.count()) > 0 && (await loc.first().getAttribute("aria-disabled")) !== "true" && !(await loc.first().isDisabled());
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || (await loc.first().isDisabled()));
const rowOf = (loc) => loc.locator("xpath=ancestor::div[contains(concat(' ', @class, ' '), ' prow ')][1]");
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function place(page, view, tab) {
  const side = page.locator(`#side [data-act="view"][data-v="${view}"]`).first();
  if (!(await side.isVisible())) { const fold = page.locator('#side [data-act="placesfold"], #side .places-h [aria-expanded="false"]').first(); if (await fold.count()) await fold.click(); }
  await side.click();
  if (tab) {
    await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"]`).first().click();
    await page.locator(`#main .place [data-act="ptab"][data-v="${tab}"][aria-selected="true"]`).first().waitFor({ timeout: 10000 });
  }
  await sleep(700);
}

/* ---------- Inbox ---------- */
async function inboxNeeds(page) {
  await place(page, "inbox", "needs");
  const notes = page.locator("#main .prow", { hasText: "keep notes" });
  await notes.waitFor({ timeout: 10000 });
  const requests = (await api("flows-boards/installs")).requests;
  const noteReq = requests.find((r) => r.ask.why === "keep notes"), diaryReq = requests.find((r) => r.ask.why === "keep a diary");
  check("places-009 install rows draw the request's own tile, no mascot or face (the mascot is the logo only)", (await notes.locator(".ico-tile").count()) === 1 && (await notes.locator(".av").count()) === 0);
  const allow = page.locator(`[data-act="xdo"][data-id="${diaryReq.id}"]`);
  check("places-009 xdo: Allow on an install request stays greyed (security tier)", await until(() => greyed(allow)));
  await shot(page, "inbox-needs-setup");
  await allow.click({ force: true }).catch(() => {});
  await sleep(500);
  check("places-009 xdo: clicking the greyed Allow changes nothing (GET /api/flows-boards/installs)", (await api("flows-boards/installs")).requests.find((r) => r.id === diaryReq.id)?.status === "waiting");
  await page.locator(`[data-act="xdo-no"][data-id="${noteReq.id}"]`).click();
  check("places-009 xdo-no: Don't declines (GET)", await until(async () => (await api("flows-boards/installs")).requests.find((r) => r.id === noteReq.id)?.status === "declined"));
  // A change to Branch itself: Decline is live, the yes and Publish stay greyed.
  await page.locator(`[data-act="selfrev15"][data-id="${NOTE.selfRequest}"]`).click();
  await page.locator(".dlg [data-act='selfno15']").waitFor({ timeout: 10000 });
  check("places-013 Approve the edits stays greyed (security tier)", await greyed(page.locator(".dlg [data-act='selfdo15']")));
  await shot(page, "inbox-selfchange-setup");
  await page.locator(".dlg [data-act='selfno15']").click();
  check("places-013 selfno15: Decline closes the request (GET /api/self-development/requests)", await until(async () => (await api("self-development/requests")).requests.find((r) => r.id === NOTE.selfRequest)?.status === "declined"));
  check("places-013 the card is gone once declined", await until(async () => (await page.locator(`[data-act="selfrev15"][data-id="${NOTE.selfRequest}"]`).count()) === 0));
}

async function inboxFinished(page) {
  await place(page, "inbox", "finished");
  const row = page.locator("#main .prow", { hasText: "September expense report" });
  await row.waitFor({ timeout: 10000 });
  check("places-014 Finished names the Trunk and draws its face", (await row.locator("small").textContent()).startsWith("Ledger · ") && (await row.locator(".av.brand, .av.none18c").count()) === 0);
  const branchRow = page.locator("#main .prow", { hasText: "Tidy the Downloads folder" });
  check("places-014 Branch's own task draws the neutral assistant tile, not a mascot", (await branchRow.locator(".av.none18c").count()) === 1 && (await branchRow.locator(".av.brand").count()) === 0);
  await shot(page, "inbox-finished-setup");
}

async function inboxHistory(page) {
  await place(page, "inbox", "history");
  const box = page.locator("#histq");
  check("places-015 Search what ran is live", await live(box));
  await box.click();
  await page.keyboard.type("ledg");
  const rows = page.locator("#main .rows .prow");
  const onlyLedger = async () => { const all = await rows.allTextContents(); return all.length > 0 && all.every((r) => r.includes("Ledger · ")) && all.some((r) => r.includes("September expense report")); };
  check("places-015 search matches a Trunk's name", await until(onlyLedger));
  check("places-015 the box keeps its words and focus", (await box.inputValue()) === "ledg" && await page.evaluate(() => document.activeElement?.id === "histq"));
  await page.keyboard.type("zzz");
  check("places-015 nothing matching says so", await until(async () => (await page.locator("#main .rows .empty").count()) === 1));
  for (let i = 0; i < 7; i++) await page.keyboard.press("Backspace");
  check("places-015 rows carry '<Trunk> · <when>', Branch's own too", await until(async () => (await page.locator("#main .rows .prow small", { hasText: "Ledger · " }).count()) >= 1 && (await page.locator("#main .rows .prow", { hasText: "Tidy the Downloads folder" }).count()) >= 1));
  await shot(page, "inbox-history-setup");
  // Watch again: Make a workflow saves the engine's draft; Save as a page downloads the engine's page.
  await page.locator(`#main .rows [data-act="replay"][data-id="${NOTE.ledgerRun}"]`).click();
  await page.locator(".dlg [data-act='rp-flow']").waitFor({ timeout: 10000 });
  const before = (await api("workflows").catch(() => ({ workflows: [] }))).workflows?.length ?? 0;
  await page.locator(".dlg [data-act='rp-flow']").click();
  check("places-015 rp-flow: Make a workflow saves it (GET /api/workflows)", await until(async () => ((await api("workflows")).workflows?.length ?? 0) > before));
  const download = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  await page.locator(".dlg [data-act='rp-page']").click();
  const file = await download;
  check("places-015 rp-page: Save as a page downloads the engine's page", file && /^task-recording-/.test(file.suggestedFilename()), file?.suggestedFilename());
  await page.locator(".dlg [data-act='dlg-close']").first().click();
}

async function inboxLater(page) {
  await place(page, "inbox", "later");
  const hand = page.locator('[data-act="laterb17"][data-id="by-hand-1"]'), outside = page.locator('[data-act="laterb17"][data-id="outside-1"]');
  await hand.waitFor({ timeout: 10000 });
  check("places-018 a step you do by hand is answered Done", (await hand.textContent()).trim() === "Done");
  check("places-018 a job an outside tool does can be given up (Stop waiting)", (await outside.textContent()).trim() === "Stop waiting");
  await shot(page, "inbox-later-setup");
  await outside.click();
  const settled = await until(async () => (await api("deferred")).deferred.find((d) => d.id === "outside-1" && d.settledAt));
  check("places-018 Stop waiting settles it (GET /api/deferred)", settled && settled.outcome === "You stopped waiting.", settled?.outcome);
  await hand.click();
  check("places-018 Done settles the step by hand (GET)", await until(async () => (await api("deferred")).deferred.find((d) => d.id === "by-hand-1")?.settledAt));
}

/* ---------- Library ---------- */
async function libraryMemory(page) {
  await place(page, "library", "memory");
  const row = page.locator("#main .prow", { hasText: "Prefers invoices as PDF" });
  await row.waitFor({ timeout: 10000 });
  await row.locator('[data-act="forget"]').click();
  check("pane-stage-025 Forget removes it (GET /api/state memory)", await until(async () => !(await api("state")).memory.some((m) => m.data?.text === "Prefers invoices as PDF")));
  const toast = page.locator(".toast", { hasText: "Forgotten." });
  check("pane-stage-025 the toast says Forgotten. with Undo", await until(async () => (await toast.count()) > 0 && (await toast.locator('[data-act="undo"]').count()) > 0, 3000));
  await shot(page, "library-forgotten-setup");
  await toast.locator('[data-act="undo"]').click();
  check("pane-stage-025 Undo puts the fact back (GET)", await until(async () => (await api("state")).memory.some((m) => m.data?.text === "Prefers invoices as PDF" && m.data?.source === "owner")));
}

async function libraryDocuments(page) {
  await place(page, "library", "documents");
  await page.locator('#main [data-act="sqlb17"]').click();
  await page.locator(".dlg [data-act='sqlrunb17']").waitFor({ timeout: 10000 });
  await page.locator(".dlg [data-act='sqlrunb17']").click();
  const chip = page.locator(".dlg [data-act='sqlqb17']", { hasText: "By category" });
  check("places-039 ready-made questions come from the engine's columns", await until(async () => (await chip.count()) === 1 && (await page.locator(".dlg [data-act='sqlqb17']", { hasText: "By payee" }).count()) === 1));
  await chip.click();
  await page.locator(".dlg [data-act='sqlrunb17']").click();
  check("places-039 By category runs as SQL over the file (the engine's table)", await until(async () => (await page.locator(".dlg .tbl-b17 tbody tr").count()) === 3 && (await page.locator(".dlg .tbl-b17 tbody tr").first().textContent()).startsWith("Travel")));
  await shot(page, "library-sql-setup");
  await page.locator(".dlg [data-act='sqlsaveb17']").click();
  check("places-039 sqlsaveb17: Save as a report keeps it in Documents (GET /api/documents)", await until(async () => (await api("documents")).documents.some((d) => d.name === "expenses, By category.md")));
  // Compare two documents, then keep the comparison.
  await page.locator('#main [data-act="doccmpb17"]').click();
  await page.locator(".dlg #doc-a-b17").waitFor({ timeout: 10000 });
  const docs = (await api("documents")).documents;
  await pickGsel(page.locator(".dlg #doc-a-b17"), docs.find((d) => d.name === "lease-2025.md").id);
  await sleep(600);
  await pickGsel(page.locator(".dlg #doc-b-b17"), docs.find((d) => d.name === "lease-2026.md").id);
  check("places-040 the engine's comparison is drawn", await until(async () => (await page.locator(".dlg .dif-b17").count()) >= 1));
  check("places-040 the Edit exactly tab is live", await live(page.locator(".dlg [data-act='docmodeb17'][data-v='edit']")));
  await shot(page, "library-compare-setup");
  await page.locator(".dlg [data-act='docsaveb17']").click();
  check("places-040 docsaveb17: Save the comparison keeps it in Documents (GET)", await until(async () => (await api("documents")).documents.some((d) => d.name === "lease-2025.md vs lease-2026.md.md")));
  await page.locator('#main [data-act="doccmpb17"]').click();
  await page.locator(".dlg [data-act='docmodeb17'][data-v='edit']").click();
  check("places-040 Make the edit stays greyed", await greyed(page.locator(".dlg [data-act='docedit17']")));
  await page.locator(".dlg [data-act='dlg-close']").first().click();
  check("places-036 Write a new document is live", await live(page.locator('#main .docacts15 [data-act="doc-new"]')));
  const firstDoc = (await api("documents")).documents[0];
  await page.locator(`#main [data-act="doc-open"][data-id="${firstDoc.id}"]`).click();
  check("places-036 Open shows the document's words in a dialog titled with its name (GET /api/documents/<id>)", await until(async () => (await page.locator(".dlg h2").first().textContent().catch(() => "")) === firstDoc.name && (await page.locator(".dlg .docread18, .dlg .made-b2, .dlg .hint").count()) > 0), firstDoc.name);
  await page.locator(".dlg [data-act='dlg-close']").first().click();
  // The Map: the engine's map drawn as topics joined to the documents their links came from.
  await page.locator('#main [data-act="dv15"][data-v="map"]').click();
  const picture = page.locator("#main .kmap15 svg");
  check("places-037 the Map draws the engine's map (topics and documents)", await until(async () => (await picture.locator(".topic15").count()) >= 1 && (await picture.locator(".doc15").count()) >= 1 && (await picture.locator("line").count()) >= 1, 15000));
  const extras = await api("knowledge/extras");
  const collection = (Array.isArray(extras.graphs) ? extras.graphs : extras.graphs?.graphs ?? [])[0]?.collection;
  const names = collection ? (await api("knowledge/graph/names", { collection })).names.map((n) => n.name) : [];
  const drawn = await picture.locator(".topic15 text").allTextContents();
  check("places-037 every topic drawn is one of the engine's names", drawn.length > 0 && drawn.every((n) => names.some((name) => name === n || (n.endsWith("…") && name.startsWith(n.slice(0, -1))))), drawn.join(", "));
  await shot(page, "library-map-setup");
  await page.locator('#main [data-act="dv15"][data-v="list"]').click();
  await place(page, "library", "made");
  const made = page.locator("#main .prow", { hasText: "chart.png" });
  await made.waitFor({ timeout: 10000 });
  check("places-041 Made for you says who made it and when", (await made.locator("small").textContent()).startsWith("Ledger · "));
  await made.locator('[data-act="made-open"]').click();
  check("places-041 Open shows the kept picture from its bytes, nothing run (GET /api/artifacts/read, /api/artifacts/file)", await until(async () => (await page.locator(".dlg h2").first().textContent().catch(() => "")) === "chart.png" && (await page.locator(".dlg img.docread18m").count()) === 1));
  await page.locator(".dlg [data-act='dlg-close']").first().click();
  await shot(page, "library-made-setup");
}

async function advanced(page) {
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setlevel"][data-v="advanced"]').first().click();
  await sleep(500);
  // Settings is a window of its own over the sidebar: back to the places before the next step walks them.
  if (await page.locator(".set-back").count()) await page.locator(".set-back").first().click();
  await page.locator("#side .set-nav").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
}

async function automationsMore(page) {
  await advanced(page);
  await place(page, "automations", "scheduled");
  await page.locator('#main [data-act="demob17"][data-k="forecast"]').click();
  await page.locator(".dlg [data-act='demodob17'][data-k='forecast']").click();
  check("places-024 forecast: Save to Library keeps the open forecasts (GET /api/documents)", await until(async () => (await api("documents")).documents.some((d) => /\.md$/.test(d.name) && !d.name.includes(",") && !d.name.includes(" vs ") && !d.name.startsWith("lease") && !d.name.startsWith("expenses"))));
  await page.locator('#main [data-act="demob17"][data-k="leads"]').click();
  const download = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  await page.locator(".dlg [data-act='demodob17'][data-k='leads']").click();
  const file = await download;
  let csv = "";
  if (file) csv = fs.readFileSync(await file.path(), "utf8");
  check("places-024 leads: Export as CSV saves the engine's leads", csv.startsWith("name,company,score") && csv.includes("Dana Reyes"), csv.split("\n")[0]);
  await page.locator(".dlg [data-act='dlg-close']").first().click().catch(() => {});
  await place(page, "automations", "checkins");
  const wk = page.locator("#hb-wk");
  check("places-032 Quiet on weekends is live", await live(wk));
  await wk.click();
  check("places-032 hb-wk: saved with the check-in (GET /api/heartbeat)", await until(async () => (await api("heartbeat")).heartbeat.settings.quietWeekends === true));
  const hours = async () => (await api("heartbeat")).heartbeat.settings.activeHours ?? null;
  await page.locator('#main [data-act="hb-hours"][data-v="work"]').click();
  check("places-032 hb-hours Work hours: 9 to 5 kept with the check-in (GET /api/heartbeat activeHours)", await until(async () => { const h = await hours(); return h?.from === "09:00" && h?.to === "17:00"; }));
  await page.locator('#main [data-act="hb-hours"][data-v="always"]').click();
  check("places-032 hb-hours Always: no hours kept (GET)", await until(async () => (await hours()) === null));
  await shot(page, "automations-checkins-setup");
}

/* Library › Documents › Managing what it reads (Advanced): Sync now asks the engine to bring in what is new (the part
   ships on, src/asks/settings.ts), then shows the engine's sources again. */
async function librarySources(page) {
  await place(page, "library", "documents");
  await page.locator('#main [data-act="demob17"][data-k="sources"]').click();
  const go = page.locator(".dlg [data-act='demodob17'][data-k='sources']");
  check("places-024 sources: Sync now is live", await until(() => live(go)));
  const synced = page.waitForResponse((r) => r.url().endsWith("/api/asks/sources/sync") && r.request().method() === "POST", { timeout: 15000 });
  await go.click();
  const answer = await synced.catch(() => null);
  check("places-024 sources: Sync now asks the engine (POST /api/asks/sources/sync answers ok)", answer?.ok() === true, String(answer?.status() ?? "no request"));
  const listed = (await api("asks/sources")).status;
  check("places-024 sources: then shows the engine's sources again, one row each (GET /api/asks/sources)", await until(async () => (await page.locator(".dlg .demo-b17 .prow").count()) === (Array.isArray(listed) ? listed.length : 0) && !(await go.isDisabled())));
  await page.locator(".dlg [data-act='dlg-close']").first().click().catch(() => {});
}

/* ---------- Automations ---------- */
async function automationsScheduled(page) {
  await place(page, "automations", "scheduled");
  const sw = page.locator(`#main input[data-sw="schedule"][data-id="${NOTE.schedule}"]`);
  await sw.waitFor({ timeout: 10000 });
  const row = rowOf(sw);
  check("places-019 the row names the Trunk that made it", (await row.locator("small").first().textContent()).endsWith("· Ledger"));
  check("places-019 health: 3 runs, one failed says it hit a snag (not \"needed you\": nothing waits in Inbox), drawn from the engine's history", ((await row.locator(".health15 small").textContent()) ?? "").trim() === "3 runs · Hit a snag");
  await shot(page, "automations-scheduled-setup");
  await sw.click();
  check("places-019 the switch pauses it (GET /api/schedules)", await until(async () => (await api(`schedules/${NOTE.schedule}`)).data.status === "paused"));
  await page.locator(`#main input[data-sw="schedule"][data-id="${NOTE.schedule}"]`).click();
  check("places-019 the switch lets it run again (GET)", await until(async () => (await api(`schedules/${NOTE.schedule}`)).data.status === "pending"));
}

async function automationsProcedures(page) {
  await place(page, "automations", "procedures");
  const run = page.locator(`#main [data-act="proc-run"][data-id="${NOTE.procedure}"]`);
  await run.waitFor({ timeout: 10000 });
  const row = rowOf(run);
  check("places-030 a waiting change shows 'Change suggested'", await until(async () => (await row.locator(".pp-pill17d").count()) === 1));
  check("places-026 Run now is live on a procedure that starts itself", await live(run));
  await run.click();
  check("places-026 proc-run: the engine asks first at its level (GET /api/autonomy/ledger)", await until(async () => (await api("autonomy/ledger")).entries.some((e) => e.kind === "start" && e.payload?.procedureId === NOTE.procedure)));
  check("places-026 the engine's reason is shown", await until(async () => (await page.locator(".toast", { hasText: "It asked you first" }).count()) > 0, 4000));
  const prompts = page.locator('#main [data-act="prompt-use"]');
  check("places-031 every saved prompt is listed (4)", (await prompts.count()) === 4);
  const long = page.locator("#main .prow", { hasText: "Monday plan" }).locator("small");
  check("places-031 a long prompt is cut at 80 characters with …", /…$/.test((await long.textContent()).trim()));
  check("places-031 Use is live", await live(prompts.first()));
  await shot(page, "automations-procedures-setup");
  await page.locator("#main .prow", { hasText: "Invoice check" }).locator('[data-act="prompt-use"]').click();
  check("places-031 Use fills the message box of the conversation", await until(async () => (await page.locator("#prompt").inputValue().catch(() => "")) === "Check my inbox for invoices"));
}

async function automationsTriggers(page) {
  await place(page, "automations", "triggers");
  const row = page.locator("#main .prow", { hasText: "New PDF in Downloads" });
  await row.waitFor({ timeout: 10000 });
  check("places-025 a trigger names the Trunk whose conversation it runs in", (await row.locator("small").textContent()).endsWith("· Ledger"));
  await shot(page, "automations-triggers-setup");
}

/* ---------- a brand-new user: every place draws, nothing made up, the same controls are live ---------- */
async function brandNew(page) {
  await place(page, "inbox", "needs");
  check("new user: Needs you draws with nothing waiting", (await page.locator("#main .prow").count()) === 0);
  check("new user: Needs you is pass 18's welcome (a pose, one line, one button)", ((await page.locator("#main .empty18c p").first().textContent().catch(() => "")) ?? "").startsWith("Nothing needs you."));
  await shot(page, "inbox-needs-new");
  await place(page, "inbox", "history");
  check("new user: Search what ran is live", await live(page.locator("#histq")));
  await page.locator("#histq").click();
  await page.keyboard.type("x");
  check("new user: searching nothing says Nothing matches.", await until(async () => (await page.locator("#main .rows .empty").textContent().catch(() => "")) === "Nothing matches."));
  await place(page, "automations", "procedures");
  check("new user: no saved prompts drawn", (await page.locator('#main [data-act="prompt-use"]').count()) === 0);
  await shot(page, "automations-procedures-new");
  await place(page, "automations", "scheduled");
  check("new user: no schedule rows", (await page.locator('#main input[data-sw="schedule"]').count()) === 0);
  await place(page, "library", "memory");
  await shot(page, "library-memory-new");
  const state = await fresh("state");
  check("new user: the engine has no runs, memory or schedules", !state.runs.length && !state.memory.length && !state.schedules.length);
}

async function open(browser, port, token, apiFn) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  await apiFn("onboarding", { done: true });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByLabel("Session token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1200);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch();
  try {
    if (PHASE === "setup") {
      const setup = await open(browser, PORT, TOKEN, api);
      for (const step of [inboxNeeds, inboxFinished, inboxHistory, inboxLater, libraryMemory, libraryDocuments, automationsScheduled, automationsProcedures, automationsTriggers, automationsMore, librarySources]) {
        try { await step(setup.page); } catch (error) { check(`${step.name} ran to the end`, false, error.message.split("\n").slice(0, 3).join(" ")); }
      }
      check("set-up user: no page or console errors", setup.errors.length === 0, setup.errors.join("; "));
    } else {
      const newbie = await open(browser, PORT, TOKEN, fresh);
      try { await brandNew(newbie.page); } catch (error) { check("brandNew ran to the end", false, error.message.split("\n")[0]); }
      check("brand-new user: no page or console errors", newbie.errors.length === 0, newbie.errors.join("; "));
    }
  } finally { await browser.close(); }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();
