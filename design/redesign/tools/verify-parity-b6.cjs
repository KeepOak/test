/* Parity batch B6 (shell, setup, walkthrough, What's new): presses every control B6 made live with a real mouse or the
   real keys, against a running engine, and confirms each change through the engine's own GET route; checks what stays
   greyed; requires zero page errors. Run it only against a throwaway engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-parity-b6.cjs
   It starts a stand-in model service on this computer (stub-model-b6.cjs, on LM Studio's own port 1234, which must be
   free) and connects it with a made-up key, so real tasks run, wait on the owner and write a file. Every switch it flips
   is put back. SHOTS=<folder> saves a screenshot at each step. */
const { chromium } = require("playwright");
const { mkdirSync } = require("node:fs");
const { start: startStub } = require("./stub-model-b6.cjs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, SHOTS = process.env.SHOTS;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const greyed = (loc) => loc.evaluate((el) => el.classList.contains("soon") || el.getAttribute("aria-disabled") === "true" || el.disabled);
const text = (loc) => loc.innerText().then((s) => s.trim());
let shot = 0;
const snap = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++shot).padStart(2, "0")}-${name}.png` }); };
const closeAll = async (page) => { for (let i = 0; i < 3; i++) { if (await page.locator(".pop, .scrim, .palette").count()) await page.keyboard.press("Escape"); } await settle(page, 300); };
async function go(page, view) { await closeAll(page); await page.locator(`.side-nav [data-act="view"][data-v="${view}"]`).click(); await settle(page, 900); }

async function signIn(page) {
  await page.goto(`${BASE}/`);
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side .side-nav").waitFor({ timeout: 60000 });
  await settle(page, 1500);
}

/* ---------- the engine's own tasks, through the stand-in model ---------- */
const runs = async () => (await api("state")).runs ?? [];
async function prepare() {
  const stub = await startStub(1234);
  await api("connections/from-preset", { provider: "lm-studio", key: "parity-b6-test-key", model: "stub-model" });
  await api("onboarding", { skipped: true, welcomed: true }); // setup, or the "New to Branch?" card, would sit on top
  const modes = await api("trunks");
  if (modes.modes?.trunks === "off") await api("trunks/switch", { part: "trunks", mode: "on" });
  if (!(await api("trunks")).trunks.some((t) => t.name === "Parity Scout")) await api("trunks", { name: "Parity Scout", description: "Finds the invoice that does not match" });
  const write = await api("run", { prompt: "WRITE the parity notes" }); // a file this conversation made
  return { stub, writeSession: write.sessionId };
}

/* ---------- the status bar, the list and the notification card ---------- */
async function statusAndList(page) {
  const gw = page.locator('#statusbar [data-act="gwpop"]');
  const before = (await api("never-break")).mode;
  check("Status bar: Gateway says off, dot unlit, as the engine has it", before === "off" && (await text(gw)).includes("Gateway off") && (await gw.locator(".dot.off").count()) === 1, `${before} · ${await text(gw)}`);
  await gw.click();
  await page.locator("#gwpop-sw").click();
  const on = await until(async () => (await api("never-break")).mode === "on");
  await closeAll(page);
  check("Status bar: the gateway switched on through the popover (GET /api/never-break on), now 'Gateway on' and lit", on && (await until(async () => (await text(gw)).includes("Gateway on") && (await gw.locator(".dot.off").count()) === 0, 5000)));
  await gw.click();
  await page.locator("#gwpop-sw").click();
  check("Status bar: put back off", await until(async () => (await api("never-break")).mode === "off"));
  await closeAll(page);

  /* A slow task: running while its answer is on its way. */
  /* POST /api/run answers when the task ends, so it is not waited for here; the task is found in the engine's list. */
  const ending = api("run", { prompt: "SLOW take your time" }).catch(() => null);
  let slow = null;
  const live = await until(async () => { slow = (await runs()).find((r) => r.prompt === "SLOW take your time" && r.status === "running") ?? null; return !!slow; });
  await settle(page, 1500);
  const count = (await runs()).filter((r) => r.status === "running" || r.status === "needs_input").length;
  const badge = page.locator('.side-nav [data-v="team"] .live6');
  check("Team in the list: the live count is the engine's running tasks (GET /api/state runs)", live && (await until(async () => (await badge.count()) === 1 && (await text(badge)) === String(count), 8000)), `${count}`);
  check("Team's count says '<n> running now'", (await badge.getAttribute("data-tip")) === `${count} running now`);
  const row = page.locator(`#side .row[data-id="${slow.sessionId}"] .av`);
  check("List avatars: the moving copper ring while its task works", await until(async () => (await row.count()) > 0 && (await row.first().evaluate((el) => el.classList.contains("working"))), 8000));
  await snap(page, "working");

  /* A task that asks: the copper dot, and the card while you are elsewhere. */
  await go(page, "library");
  const ask = await api("run", { prompt: "ASK where the notes go" });
  const waiting = await until(async () => (await api("state")).attention?.some((a) => a.runId === ask.id));
  const question = (await api("state")).attention.find((a) => a.runId === ask.id)?.question;
  const card = page.locator(".notif");
  check("Notification card: shown while elsewhere, 'Branch · now' and the task's own question", waiting && (await until(async () => (await card.count()) === 1, 8000)) && (await text(card.locator("small"))) === "Branch · now" && (await text(card.locator("p"))) === question, question);
  await snap(page, "notif");
  const dot = page.locator(`#side .row[data-id="${ask.sessionId}"] .av`);
  check("List avatars: the copper dot while its task waits for you", await until(async () => (await dot.count()) > 0 && (await dot.first().evaluate((el) => el.classList.contains("waiting"))), 5000));
  await card.getByRole("button", { name: "Open" }).click();
  await settle(page, 1200);
  check("Notification card: Open opens that conversation", (await page.locator(`#side .row[data-id="${ask.sessionId}"][aria-current="true"]`).count()) === 1 && (await card.count()) === 0);
  await go(page, "overview");
  const ask2 = await api("run", { prompt: "ASK once more" });
  await until(async () => (await card.count()) === 1, 10000);
  await card.locator('[data-act="notif-x"]').click();
  check("Notification card: dismissed with its X", (await card.count()) === 0 && (await api("state")).attention.some((a) => a.runId === ask2.id));
  for (const id of [ask.id, ask2.id]) await api(`runs/${id}/cancel`, {}).catch(() => null);
  return ending;
}

/* ---------- running in the background: pause and resume every Trunk ---------- */
async function pauseAll(page) {
  await closeAll(page);
  await page.locator('#statusbar [data-act="tasks10"]').click();
  const row = page.locator('.pop [data-act="pauseall"]');
  await row.waitFor({ timeout: 5000 });
  check("Running in the background: 'Pause all Trunks' is the last row, live", (await row.count()) === 1 && (await text(row)) === "Pause all Trunks" && !(await greyed(row)), `${await row.count()} · ${await text(row).catch(() => "")} · greyed ${await greyed(row).catch(() => "?")}`);
  await row.click();
  const paused = await until(async () => (await api("trunks")).trunks.every((t) => t.paused));
  check("Pause all Trunks: every Trunk paused (GET /api/trunks)", paused);
  await settle(page, 1200); // the window reads the Trunks again after the change
  await page.locator('#statusbar [data-act="tasks10"]').click();
  const again = page.locator('.pop [data-act="pauseall"]');
  await again.waitFor({ timeout: 5000 });
  check("…then the row reads 'Resume all Trunks'", (await text(again)) === "Resume all Trunks");
  await again.click();
  check("Resume all Trunks: none paused (GET /api/trunks)", await until(async () => (await api("trunks")).trunks.every((t) => !t.paused)));
  await closeAll(page);
}

/* ---------- versions: the update menu, Release notes, What's new, Settings › Updates ---------- */
async function versions(page) {
  const notes = await api("release-notes");
  await closeAll(page);
  await page.locator('#statusbar [data-act="updmenu"]').click();
  const pop = page.locator(".pop");
  check("Version menu: 'Branch <installed>' from the engine (no ready version in a browser)", (await text(pop.locator(".pt"))) === `Branch ${(await api("state")).version}`);
  check("Version menu: Install and Remind me tomorrow stay greyed (the desktop's updater; no engine snooze)", (await greyed(pop.locator('[data-act="install"]'))) && (await greyed(pop.locator('[data-act="closepop"]'))));
  await pop.locator('[data-act="relnotes17d"]').click();
  const dlg = page.locator(".scrim .dlg");
  await dlg.waitFor();
  const shownTitles = await dlg.locator(".rn-g17d li > span").allInnerTexts();
  const heads = await dlg.locator(".rn-g17d h3").allInnerTexts();
  const wantHeads = ["new", "better", "fixed"].filter((g) => notes.items.some((n) => (n.group ?? "new") === g)).map((g) => ({ new: "New", better: "Better", fixed: "Fixed" })[g]);
  check("Release notes: every note the engine ships for this version, under its group (GET /api/release-notes)", JSON.stringify(shownTitles.slice().sort()) === JSON.stringify(notes.items.map((n) => n.title).sort()) && JSON.stringify(heads) === JSON.stringify(wantHeads), `${shownTitles.length} notes; ${heads.join("/")}`);
  check("Release notes: the version is the engine's", (await text(dlg.locator(".hint"))).startsWith(`Branch Agent ${notes.version}.`));
  await snap(page, "relnotes");
  const show = dlg.locator('[data-act="rngo17d"][data-a="shortcuts"]');
  await show.click();
  check("Release notes: Show me opens where the note lives (Shortcuts you set → Keyboard shortcuts)", await until(async () => (await page.locator(".scrim .keys15").count()) === 1, 4000));
  await closeAll(page);

  await page.locator('[data-act="guide"]').click();
  await page.locator('.pop [data-act="whatsnew13"]').click();
  const rows = page.locator(".scrim .new-row13");
  await rows.first().waitFor();
  check("What's new: one row per engine note", (await rows.count()) === notes.items.length, `${await rows.count()}`);
  await page.locator('.scrim .new-row13[data-a="wb-open17d"]').click();
  await settle(page, 1200);
  check("What's new: 'Learn an app, and prove it' opens Customize › Tools › Skills at learn-this", (await page.locator("#main .wb17d").count()) >= 1 && (await page.locator('.side-nav [data-v="customize"][aria-current="true"]').count()) === 1);
  await page.locator('[data-act="guide"]').click();
  await page.locator('.pop [data-act="whatsnew13"]').click();
  await page.locator('.scrim .new-row13[data-a="relnotes17d"]').click();
  check("What's new: the Release notes row opens Release notes", await until(async () => (await page.locator(".scrim .rn17d").count()) === 1, 4000));
  await closeAll(page);

  await page.keyboard.press("Control+,");
  await page.locator('[data-act="setpage"][data-v="updates"]').first().click();
  await settle(page, 1200);
  const rn = page.locator(".rn-row17d");
  check("Settings › Updates: 'You have <version>. See what it has.' with Release notes", (await text(rn.locator(".grow"))) === `You have ${notes.version}. See what it has.`);
  await rn.locator('[data-act="relnotes17d"]').click();
  check("Settings › Updates: Release notes opens the dialog", await until(async () => (await page.locator(".scrim .rn17d").count()) === 1, 4000));
  await closeAll(page);
  await page.locator('[data-act="owner"]').click();
  check("Owner menu: no 'Update to …' row while no newer version waits (browser)", (await page.locator('.pop [data-act="updmenu-go"]').count()) === 0);
  await closeAll(page);
}

/* ---------- the palette ---------- */
async function palette(page) {
  await closeAll(page);
  await page.keyboard.press("Control+k");
  await page.locator("#pal-in").waitFor();
  const labels = await page.locator(".palette .mi .mi-t").allInnerTexts();
  check("Palette: 'New Trunk' and 'Turn Lockdown on' among the actions", labels.includes("New Trunk") && labels.includes("Turn Lockdown on"));
  const trunk = (await api("trunks")).trunks.find((t) => t.name === "Parity Scout");
  const sub = await page.locator(".palette .mi", { hasText: "Parity Scout" }).first().locator(".r").innerText().catch(() => "");
  check("Palette: a Trunk's conversation shows what the Trunk is for", sub.trim() === trunk.description, sub);
  await page.locator("#pal-in").fill("Turn Lockdown on");
  await page.locator(".palette .mi", { hasText: "Turn Lockdown on" }).click();
  check("Palette: Turn Lockdown on (GET /api/lockdown on)", await until(async () => (await api("lockdown")).on === true));
  await settle(page, 800);
  await page.keyboard.press("Control+k");
  const again = await page.locator(".palette .mi .mi-t").allInnerTexts();
  check("Palette: no 'Turn Lockdown off' is offered (loosening stays with the banner)", !again.some((l) => /Lockdown off/.test(l)) && !again.includes("Turn Lockdown on"));
  await closeAll(page);
  await api("lockdown", { on: false });
  await settle(page, 1500);
}

/* ---------- the sidebar's search ---------- */
async function search(page, writeSession) {
  await closeAll(page);
  const box = page.locator("#side-q");
  await box.fill("parity-b6");
  await settle(page, 1500);
  const file = page.locator('#side .sr-row[data-act="chat"]', { hasText: "parity-b6-notes.txt" });
  const made = (await runs()).some((r) => (r.changes ?? []).some((c) => c.path === "parity-b6-notes.txt" && !c.existed));
  check("Search: Files and memory lists the file a conversation made (GET /api/state runs[].changes)", made && (await file.count()) === 1 && (await text(file.locator("small"))).endsWith("· Made"));
  await file.click();
  await settle(page, 1200);
  check("Search: the file row opens its conversation", await until(async () => (await page.locator("#main").innerText()).includes("WRITE the parity notes"), 5000));
  await box.fill("parity notes");
  await settle(page, 1800);
  const found = (await api("sessions/search", { query: "parity notes" })).sessions;
  const past = page.locator('#side .sr-row[data-act="sr-sess"] small');
  const lines = await past.allInnerTexts();
  check("Search: a past session shows the line it was found by (POST /api/sessions/search match)", found.some((s) => s.match) && lines.some((l) => found.some((s) => s.match && l.includes(s.match.slice(0, 20)))), lines[0] ?? "");
  await box.fill("zzqx-nothing-here");
  await settle(page, 1200);
  check("Search: no results shows a line icon, never the mascot (the owner's faces rule)", (await page.locator("#side .sq-none svg.i").count()) === 1 && (await page.locator("#side .sq-none :is(img, video)").count()) === 0);
  await box.fill("");
  await page.keyboard.press("Escape");
  await settle(page, 400);
}

/* ---------- the keys ---------- */
async function keys(page) {
  await closeAll(page);
  await page.locator('[data-act="owner"]').click();
  await page.locator('.pop [data-act="shortcuts"]').click();
  const names = await page.locator(".scrim .k-row15 > span:first-child").allInnerTexts();
  check("Keyboard shortcuts: Focus mode, Talk live, Stop the current task, Open the Inbox, Next conversation can be changed", ["Focus mode", "Talk live", "Stop the current task", "Open the Inbox", "Next conversation"].every((n) => names.includes(n)), names.join(", "));
  check("Keyboard shortcuts: no Lockdown key (it would also turn Lockdown off)", !names.some((n) => /Lockdown/.test(n)));
  const fixed = await page.locator(".scrim .shortcuts > span:nth-child(odd)").allInnerTexts();
  check("Keyboard shortcuts: '@' and '/' among the fixed keys", fixed.includes("Call a Trunk in a message") && fixed.includes("Use a skill"));
  await page.locator('.scrim [data-act="key15"][data-v="openInbox"]').click();
  await page.keyboard.press("Alt+i");
  check("Open the Inbox: new keys kept by the engine (GET /api/comfort keys.openInbox)", await until(async () => (await api("comfort")).values.keys.openInbox === "Alt+I"));
  await settle(page, 800); // the list is drawn again with the new keys
  await closeAll(page);
  await page.keyboard.press("Alt+i");
  await settle(page, 800);
  check("Open the Inbox: the new keys open the Inbox", (await page.locator('.side-nav [data-v="inbox"][aria-current="true"]').count()) === 1);
  await page.locator('[data-act="owner"]').click();
  await page.locator('.pop [data-act="shortcuts"]').click();
  await page.locator('.scrim [data-act="keyreset15"][data-v="openInbox"]').click();
  check("Open the Inbox: put back (GET /api/comfort keys.openInbox Ctrl+I)", await until(async () => (await api("comfort")).values.keys.openInbox === "Ctrl+I"));
  await settle(page, 800);
  await closeAll(page);
  check("Dialog: closing it gives the keyboard back to the button that opened it", await page.evaluate(() => document.activeElement?.dataset?.act === "owner"));

  /* Tab stays in the dialog. */
  await page.locator('[data-act="owner"]').click();
  await page.locator('.pop [data-act="about"]').click();
  await page.locator(".scrim .dlg").waitFor();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  check("Dialog: Tab stays inside it", await page.evaluate(() => !!document.activeElement?.closest(".scrim .dlg")));
  await closeAll(page);

  await go(page, "overview");
  await page.keyboard.press("Control+.");
  await settle(page, 500);
  const focus = await page.evaluate(() => ({ focus: document.getElementById("app").classList.contains("focus"), merged: document.querySelector(".titlebar").classList.contains("merged14") }));
  check("Focus mode: Ctrl+. (the engine's focusMode keys) steps the list aside, and the title row is its own", focus.focus && !focus.merged);
  await page.keyboard.press("Escape");
  await settle(page, 400);
  check("Focus mode: Escape leaves it", !(await page.evaluate(() => document.getElementById("app").classList.contains("focus"))));

  const ids = await page.locator("#side .row[data-id]").evaluateAll((rows) => rows.map((r) => r.dataset.id));
  await page.locator(`#side .row[data-id="${ids[0]}"]`).click();
  await settle(page, 800);
  await page.keyboard.press("Control+Tab");
  await settle(page, 1000);
  check("Next conversation: Ctrl+Tab opens the next one in the list", ids.length > 1 && (await page.locator(`#side .row[data-id="${ids[1]}"][aria-current="true"]`).count()) === 1);
}

/* ---------- the rest of the shell ---------- */
async function shell(page) {
  await closeAll(page);
  const list = page.locator("#side .list");
  await list.evaluate((el) => el.dispatchEvent(new Event("scroll")));
  const on = await list.evaluate((el) => el.classList.contains("sb-on14"));
  await settle(page, 1300);
  check("Scrollbars show while a box scrolls and hide a second after", on && !(await list.evaluate((el) => el.classList.contains("sb-on14"))));

  await page.locator('#statusbar [data-hide="gateway"]').click({ button: "right" });
  await page.locator('.pop [data-act="hide"]').click();
  check("Right-click › Hide this: kept by the engine (GET /api/state preferences.hidden)", await until(async () => ((await api("state")).preferences?.hidden ?? []).includes("gateway")));
  await api("preferences", { ...(await api("state")).preferences, hidden: ((await api("state")).preferences.hidden ?? []).filter((x) => x !== "gateway") });
  await settle(page, 1500);

  check("Minimize and Quit stay greyed in a browser (the desktop app draws its own)", (await greyed(page.locator('.win [data-act="win-min"]'))) && (await greyed(page.locator('.win [data-act="quit"]'))));

  /* The conversation menu: Pinned messages. */
  const sid = (await api("state")).runs.find((r) => r.status === "completed")?.sessionId;
  const msgs = (await api(`sessions/${sid}`)).messages.filter((m) => m.role === "assistant" && m.content);
  await api(`sessions/${sid}/pins`, { messageId: msgs[0].messageId, pinned: true });
  await page.locator(`#side .row[data-id="${sid}"]`).click();
  await settle(page, 1500);
  await page.locator('[data-act="chatmenu"]').first().click();
  const pinned = page.locator('.pop [data-act="pinlist15"]');
  check("Conversation menu: 'Pinned messages 1' (GET /api/sessions/<id>/pins)", (await pinned.count()) === 1 && (await text(pinned.locator(".r"))) === String((await api(`sessions/${sid}/pins`)).pins.length));
  check("Conversation menu: Pin to top is live for a plain conversation (POST /api/sessions/<id>/pin, batch A)", (await page.locator('.pop [data-act="pin-id"]').count()) === 1 && !(await greyed(page.locator('.pop [data-act="pin-id"]'))));
  await pinned.click();
  check("Pinned messages opens the pinned list", await until(async () => (await page.locator(".pop .pinrow15").count()) === 1, 3000));
  await closeAll(page);
  await api(`sessions/${sid}/pins`, { messageId: msgs[0].messageId, pinned: false });

  await go(page, "inbox"); // both questions were cancelled above, so nothing waits
  const empties = await page.locator("#main p.empty").count();
  check("An empty list in the Inbox shows no mascot (the owner's faces rule)", (await page.locator("#main :is(p.empty, .empty18c) :is(img, video)").count()) === 0, `${empties} empty lists`);

  await closeAll(page);
  await page.locator(".side-nav [data-v=\"customize\"]").click();
  await page.locator('[data-v="everywhere"]').first().click();
  await settle(page, 1200);
  const sw = page.locator("#dash-b6");
  check("Customize › Everywhere: Dashboard in the browser, live, off as the engine has it", (await sw.count()) === 1 && !(await sw.isChecked()) && (await api("dashboard/settings")).mode === "off");
  await sw.click();
  check("Dashboard switched on (GET /api/dashboard/settings on)", await until(async () => (await api("dashboard/settings")).mode === "on"));
  await page.locator("#dash-b6").click();
  check("Dashboard put back off", await until(async () => (await api("dashboard/settings")).mode === "off"));
}

/* ---------- the first run ---------- */
async function firstRun(page) {
  await closeAll(page);
  await page.locator('[data-act="owner"]').click();
  await page.locator('.pop [data-act="firstrun"]').click();
  await page.locator(".first").waitFor();
  await page.locator('.first [data-act="fr-next"]').first().click(); // hello
  await page.locator('.first [data-act="fr-next"]').first().click(); // how it thinks
  await settle(page, 800);
  const pools = (await api("accounts")).pools ?? [];
  const accs = page.locator('.first [data-act="fr-acc"]');
  check("First run: one row per account the engine has (GET /api/accounts)", (await accs.count()) === pools.reduce((n, p) => n + (p.accounts?.length ?? 0), 0), `${await accs.count()}`);
  if (await accs.count()) {
    check("First run: 'Sign in on their site' is live", !(await greyed(accs.first())));
    await accs.first().click();
    const wizard = await until(async () => (await page.locator(".scrim .dlg").count()) === 1, 6000);
    check("First run: it opens Add an account for that service, over the first run", wizard && !(await page.locator(".first").isVisible()));
    await page.keyboard.press("Escape");
    check("First run: comes back when that closes", await until(async () => page.locator(".first").isVisible(), 4000));
  }
  for (let i = 0; i < 6 && !(await page.locator('.first [data-act="fr-tour"]').count()); i++) {
    const next = page.locator('.first [data-act="fr-next"], .first [data-act="fr-recs"]').first();
    if (await next.count()) await next.click(); else break;
    await settle(page, 700);
  }
  if (!(await page.locator('.first [data-act="fr-tour"]').count())) { await page.locator('.first [data-act="fr-tmpl"]').first().click().catch(() => null); await settle(page, 1500); }
  check("First run › All set: the four things to try", (await page.locator(".first .steps-list li").count()) === 4);
  await page.keyboard.press("Escape");
  await settle(page, 500);
}

/* ---------- the walkthrough ---------- */
async function walkthrough(page) {
  await closeAll(page);
  await page.locator('[data-act="guide"]').click();
  await page.locator('.pop [data-act="tour"]').click();
  const card = page.locator(".tour-card");
  await card.waitFor();
  await settle(page, 600);
  const total = Number(/of (\d+)/i.exec(await card.locator(".n").textContent())?.[1]);
  let seen = 0, missed = [];
  for (let i = 0; i < 40; i++) {
    seen++;
    const n = (await card.locator(".n").textContent()).trim(), title = await text(card.locator("b"));
    const spot = await page.evaluate(() => { const s = document.querySelector(".tour-spot"); return s && !s.classList.contains("none") ? s.getBoundingClientRect().width : 0; });
    if (!n.startsWith(`${seen} of ${total}`) || (seen < total && spot < 2)) missed.push(`${n}:${title}`);
    const next = card.locator('[data-act="tour-next"]');
    if (!(await next.count())) break;
    await next.click();
    await settle(page, 450);
  }
  check("Walkthrough: 'n of N' counts only the stops this window shows, each one spotlit", seen === total && total >= 10 && !missed.length, `${seen} of ${total}${missed.length ? " · " + missed.join(", ") : ""}`);
  await card.locator('[data-act="tour-end"]').click();
  await settle(page, 400);
}

(async () => {
  const errors = [];
  let stub = null;
  const browser = await chromium.launch({ headless: true });
  try {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const setup = await prepare();
    stub = setup.stub;
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page);
    check("The first-load moment leaves once the engine has answered", (await page.locator(".splash11").count()) === 0);
    await statusAndList(page);
    await pauseAll(page);
    await versions(page);
    await palette(page);
    await search(page, setup.writeSession);
    await keys(page);
    await shell(page);
    await firstRun(page);
    await walkthrough(page);
  } catch (error) {
    check("the script ran to the end", false, error.message);
  } finally {
    await browser.close();
    stub?.close();
  }
  check("zero page errors", errors.length === 0, errors.join(" | "));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
