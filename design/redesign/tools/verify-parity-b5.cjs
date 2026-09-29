/* Parity batch B5 (Settings pages and OS permissions): clicks every control B5 made live with a real mouse, against a
   running engine, and confirms each change through the engine's own GET route; then walks every Settings page at every
   level, opens every row dialog that is live, and counts what is still greyed. Each switch is flipped and flipped back,
   so the engine ends as it began. Zero page errors are required. Run it only against a throwaway engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> WORKSPACE=<that workspace> node design/redesign/tools/verify-parity-b5.cjs
   With WORKSPACE set (holding a file note.txt), putting a checkpoint back is checked on the file itself.
   SHOTS=<folder> saves a screenshot of every page. PHONE=1 also opens Settings as a paired phone (a touch screen with
   the phone's kept secret) and checks the computer-only rows are not drawn. It starts no stand-in servers. */
const { chromium, devices } = require("playwright");
const { mkdirSync } = require("node:fs");

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
const kit = async (key, field = "mode") => (await api("settings-kit")).settings.find((s) => s.key === key)?.fields.find((f) => f.field === field)?.value;
const knob = async (card, field) => (await api("knobs")).values[card][field];
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function signIn(page) {
  await page.goto(`${BASE}/`);
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#app").waitFor();
  await settle(page, 2500);
  if (await page.locator(".ob9, .scrim").count()) await page.keyboard.press("Escape");
  await settle(page, 400);
}
async function level(page, v) { await page.locator(`[data-act="setlevel"][data-v="${v}"]`).first().click(); await settle(page, 400); }
async function openPage(page, id, lv = "technical") {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await level(page, lv);
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}
const closeDialog = async (page) => { if (await page.locator(".scrim .dlg").count()) { await page.keyboard.press("Escape"); await settle(page, 300); } };
const greyed = (loc) => loc.evaluate((el) => el.classList.contains("soon") || el.getAttribute("aria-disabled") === "true" || el.disabled);

/* A switch drawn by id: flipped with the mouse, the engine read back, and flipped back. */
async function flip(page, pageId, id, read, name) {
  await openPage(page, pageId);
  const box = page.locator(`#${id}`);
  if (!(await box.count())) { check(`${name}: drawn`, false, id); return; }
  check(`${name}: live`, !(await greyed(box)));
  const was = await read();
  await box.click();
  await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  const now = await read();
  check(`${name}: the engine changed`, JSON.stringify(now) !== JSON.stringify(was), `${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
  await page.locator(`#${id}`).click();
  await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  check(`${name}: flipped back`, JSON.stringify(await read()) === JSON.stringify(was), JSON.stringify(await read()));
}
/* A number box: typed, the engine read back, then put back as it was. */
async function type(page, pageId, id, value, read, name) {
  await openPage(page, pageId);
  const box = page.locator(`#${id}`);
  if (!(await box.count())) { check(`${name}: drawn`, false, id); return; }
  const was = await read();
  await box.fill(String(value)); await box.press("Tab"); await settle(page, 1500);
  check(`${name}: the engine keeps ${value}`, (await read()) === value, JSON.stringify(await read()));
  await page.locator(`#${id}`).fill(was == null ? "" : String(was)); await page.locator(`#${id}`).press("Tab"); await settle(page, 1500);
  check(`${name}: put back`, (await read()) === was, JSON.stringify(await read()));
}
/* A segmented choice: pressed with the mouse, read back, and the first choice pressed again. */
async function seg(page, pageId, selector, read, expect, name) {
  await openPage(page, pageId);
  const was = await read();
  const btn = page.locator(selector).first();
  if (!(await btn.count())) { check(`${name}: drawn`, false, selector); return; }
  check(`${name}: live`, !(await greyed(btn)));
  await btn.click(); await settle(page, 1500);
  if (await page.locator('[data-act="kitconf17"]').count()) { await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
  const now = await read();
  check(`${name}: the engine keeps it`, JSON.stringify(now) === JSON.stringify(expect), JSON.stringify(now));
  check(`${name}: pressed as the engine says`, (await page.locator(selector).first().getAttribute("aria-pressed")) === "true");
  return was;
}

/* ---------- General ---------- */
async function general(page) {
  await flip(page, "general", "g-cmds", () => kit("command-catalog"), "General › The shared commands");
  await flip(page, "general", "f15-summarise-older-turns-by-themselves", () => knob("compaction", "autoCompact"), "General › Summarise older turns");
  await type(page, "general", "f15-summarise-when", 70, () => knob("compaction", "compactAtPercent"), "General › Summarise when it's this full");
  await type(page, "general", "f15-keep-latest", 9, () => knob("compaction", "keepRecentMessages"), "General › Always keep the latest");
  await flip(page, "general", "f15-repair-the-history-before-each-call", () => kit("safety-history-repair"), "General › Repair the history");
  const room = await knob("compaction", "contextWindowTokens");
  await seg(page, "general", '[data-act="knobseg17"][data-field="contextWindowTokens"][data-j="200000"]', () => knob("compaction", "contextWindowTokens"), 200000, "General › Room to plan for 200k");
  await page.locator(`[data-act="knobseg17"][data-field="contextWindowTokens"][data-j="${JSON.stringify(room)}"]`).first().click(); await settle(page, 1200);
  check("General › Room to plan for put back", (await knob("compaction", "contextWindowTokens")) === room);
  /* Start with Windows: the engine answers in its own words (it refuses unless Branch is installed). */
  await openPage(page, "general");
  const start = page.locator("#g-start");
  check("General › Start with Windows: live", start && !(await greyed(start)));
  const before = (await api("deployment")).autostart?.enabled;
  await start.click(); await settle(page, 1500);
  const toast = await page.locator(".toast").textContent().catch(() => "");
  const after = (await api("deployment")).autostart?.enabled;
  check("General › Start with Windows: the engine answered", after !== before || /installed/.test(toast ?? ""), toast || String(after));
  if (after !== before) { await page.locator("#g-start").click(); await settle(page, 1500); }
  /* A project's own instructions. */
  const projects = (await api("projects")).all;
  if (projects.length) {
    const p = projects[0];
    await page.locator(`[data-act="proj-edit"][data-v="${p.id}"]`).first().click(); await settle(page, 500);
    await page.locator("#proj-text").fill("Parity B5 check"); await page.locator('[data-act="proj-save"]').click(); await settle(page, 1200);
    const saved = (await api("projects")).all.find((x) => x.id === p.id);
    check("General › Edit a project's instructions: saved", saved?.instructions === "Parity B5 check" && saved.name === p.name);
    await api("projects", { ...saved, instructions: p.instructions ?? "" });
  }
}

/* ---------- every row dialog (pass 17b) on every page ---------- */
async function demos(page) {
  for (const id of ["general", "people", "appearance", "instructions", "models", "accounts", "voice", "chatapps", "permissions", "computer", "secrets", "usage", "self", "updates", "advanced", "developer"]) {
    await openPage(page, id);
    const rows = await page.locator('.set-col [data-act="demob17"]').evaluateAll((els) => els.map((e) => e.dataset.k));
    for (const k of rows) {
      await page.locator(`.set-col [data-act="demob17"][data-k="${k}"]`).first().click();
      await page.locator(".scrim .dlg").waitFor({ timeout: 15000 }).catch(() => {});
      await settle(page, 300);
      const open = await page.locator(".scrim .dlg").count();
      const body = open ? await page.locator(".scrim .dlg .demo-b17").innerText().catch(() => "") : "";
      check(`${id} › ${k}: opens the engine's readout`, open === 1, body.split("\n").slice(0, 2).join(" | ").slice(0, 100));
      await closeDialog(page);
    }
  }
}

/* ---------- helpers for the rows below ---------- */
/* A loosening confirm: the engine's own words (its 409 for the same body), and nothing changes until its yes is pressed. */
const dlgText = async (page) => ((await page.locator(".scrim .dlg p").first().textContent().catch(() => "")) ?? "").trim();
const toastText = async (page) => ((await page.locator(".toast").first().textContent().catch(() => "")) ?? "").trim();
async function refusal(path, body) {
  try { await api(path, body); return null; } catch (error) { return error.message.replace(/^[^:]+: /, ""); }
}
const post = (p, body) => api(p, body);
/* A row inside a folded "Advanced" part: its summary is pressed, as a person would, before the row is used. */
async function reveal(page, selector) {
  const el = page.locator(selector).first();
  if (await el.isVisible()) return el;
  const summary = page.locator(`details:has(${selector}) > summary`).first();
  if (await summary.count()) { await summary.click(); await settle(page, 300); }
  return el;
}

/* ---------- Permissions ---------- */
async function permissions(page) {
  /* Each is one settings-kit switch; a change that makes Branch less careful waits for the engine's words and a yes. */
  let confirms = 0;
  for (const [id, key, name] of [["p-record", "run-recording", "Record tasks"], ["p-loop", "loop_guard", "Stop a Trunk that repeats itself"],
    ["f15-scan-commands-for-hidden-characters", "safety-command-scan", "Scan commands for hidden characters"]]) {
    await openPage(page, "permissions");
    const box = page.locator(`#${id}`);
    if (!(await box.count())) { check(`Permissions › ${name}: drawn`, false); continue; }
    check(`Permissions › ${name}: live`, !(await greyed(box)));
    const was = await kit(key);
    for (let i = 0; i < 2; i += 1) {
      await (await reveal(page, `#${id}`)).click(); await settle(page, 1500);
      if (await page.locator('[data-act="kitconf17"]').count()) { confirms += 1; await page.locator('[data-act="kitconf17"]').click(); await settle(page, 1500); }
      const now = await kit(key);
      check(`Permissions › ${name}: ${i ? "put back" : "the engine changed"}`, i ? JSON.stringify(now) === JSON.stringify(was) : JSON.stringify(now) !== JSON.stringify(was), `${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
    }
  }
  console.log(`      the engine asked for a yes before loosening ${confirms} time(s); each was answered from its own dialog`);
  await openPage(page, "permissions");
  /* Security review: drawn from the engine and greyed. */
  const pii = (await api("privacy")).pii?.outbound ?? "off", code = (await api("safety-extras")).modes["code-approvals"];
  check("Permissions › Scan for personal details: greyed, pressed as the engine says", await greyed(page.locator("#f15-scan-for-personal-details"))
    && (await page.locator("#f15-scan-for-personal-details").isChecked()) === (pii !== "off"), pii);
  check("Permissions › Authenticator code: greyed, pressed as the engine says", await greyed(page.locator("#f15-authenticator-code-for-sensitive-tools"))
    && (await page.locator("#f15-authenticator-code-for-sensitive-tools").isChecked()) === (code !== "off"), code);
  /* The system sandbox: live only where the engine says this computer has one; otherwise its reason is the tip. */
  const wall = (await api("os-sandbox")).computer;
  const wallBtn = page.locator('.set-col [data-act="kitseg17"][data-key="os-sandbox"], .set-col .seg[aria-label="System sandbox for commands"] button').first();
  if (wall.available) check("Permissions › System sandbox: live", !(await greyed(wallBtn)));
  else check("Permissions › System sandbox: greyed with the engine's reason under it", (await greyed(wallBtn))
    && (await page.locator('.set-col .ctl:has(.seg[aria-label="System sandbox for commands"]) > small').first().textContent()) === wall.reason, wall.reason);
  /* This computer's own settings: only the desktop app opens them, so in a browser the button is greyed. */
  const sys = page.locator('.set-col [data-act^="sys16"]');
  for (let i = 0; i < await sys.count(); i += 1) check("Permissions › Open Windows Settings: greyed in a browser", await greyed(sys.nth(i)));
  /* Emergency stop: Stop everything asks first, then holds every task; Let them resume lets it go. */
  const row = page.locator('.set-col [data-act="estopb17"]');
  check("Permissions › Stop everything: live", (await row.count()) === 1 && !(await greyed(row)));
  await row.click(); await settle(page, 500);
  check("Permissions › Stop everything: asks first", (await page.locator(".scrim .dlg").count()) === 1 && (await api("safety-extras")).stop.everything === false);
  await page.locator('.scrim [data-act="estopgob17"]').click(); await settle(page, 1500);
  const held = (await api("safety-extras")).stop;
  check("Permissions › Stop everything: the engine holds every task", held.everything === true, JSON.stringify(held));
  const resume = page.locator('.set-col [data-act="estoprelb17"]');
  check("Permissions › Let them resume: live while only every-task is held", (await resume.count()) === 1 && !(await greyed(resume)));
  const words = await refusal("safety-extras/stop/release", {});
  await resume.click(); await settle(page, 1500);
  check("Permissions › Let them resume: asks with the engine's words first", words && (await dlgText(page)) === words && (await api("safety-extras")).stop.everything === true, words ?? "");
  await page.locator('.scrim [data-act="estopyesb17"]').click(); await settle(page, 1500);
  const after = (await api("safety-extras")).stop;
  check("Permissions › Let them resume: the engine let it go", after.engaged === false, JSON.stringify(after));
  /* A network stop set elsewhere would go with a release, so resume greys while one is held. */
  await post("safety-extras/stop", { everything: true, network: true });
  await openPage(page, "permissions");
  check("Permissions › Let them resume: greyed while another level is held", await greyed(page.locator('.set-col [data-act^="estoprelb17"]').first()));
  await post("safety-extras/stop/release", { confirmLoosening: true });
}

/* ---------- Data & usage ---------- */
async function usage(page) {
  const ret = (await api("retention")).settings;
  await openPage(page, "usage");
  await page.locator('.set-col [data-act="keep15"][data-v="30"]').click(); await settle(page, 1500);
  const r30 = (await api("retention")).settings;
  check("Data & usage › Keep conversations 30 days: the engine keeps it", r30.enabled === true && r30.keepDays === 30, JSON.stringify(r30));
  const longer = await refusal("retention", { ...r30, enabled: false, keepDays: 0 });
  await page.locator('.set-col [data-act="keep15"][data-v="forever"]').click(); await settle(page, 1500);
  check("Data & usage › Keep conversations forever: asks with the engine's words first", longer && (await dlgText(page)) === longer && (await api("retention")).settings.keepDays === 30, longer ?? "");
  await page.locator('.scrim [data-act="keeploosen15"]').click(); await settle(page, 1500);
  const rf = (await api("retention")).settings;
  check("Data & usage › Keep conversations forever: the engine keeps it", rf.enabled === false, JSON.stringify(rf));
  await post("retention", { ...ret, confirmLoosening: true });
  /* Checkpoints: one taken now, the file changed, then put back from the list. */
  const snap = await post("history/snapshots", { label: "Parity B5 check" });
  const fs = require("node:fs"), file = process.env.WORKSPACE ? `${process.env.WORKSPACE}/note.txt` : null;
  const before = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (file && before !== null) fs.writeFileSync(file, "changed after the checkpoint");
  await page.locator('.set-col [data-act="ckpts15"]').click(); await settle(page, 1200);
  const put = page.locator(`.scrim [data-act="ckptback15"][data-id="${snap.id}"]`);
  check("Data & usage › Checkpoints: the engine's list", (await put.count()) === 1, snap.id);
  await put.click(); await settle(page, 2000);
  if (file && before !== null) check("Data & usage › Put back: the file is as it was", fs.readFileSync(file, "utf8") === before);
  else console.log("      (set WORKSPACE=<the engine's workspace> holding note.txt to check the file itself)");
  check("Data & usage › Put back: the engine kept a checkpoint of what was there", (await api("history/snapshots")).snapshots.length >= 2);
  await closeDialog(page);
  /* The report: the engine's day rows added up. */
  /* The report card opens on its 30 days. */
  const days = (await api("usage?range=30&by=day")).data ?? [];
  await page.locator('.set-col [data-act="repopen15"]').click(); await settle(page, 800);
  check("Data & usage › Open the report: four tiles", (await page.locator(".scrim .rp-top15 > div").count()) === 4);
  const csv = page.locator('.scrim [data-act="repcsv15"]');
  if (days.length) {
    const [download] = await Promise.all([page.waitForEvent("download"), csv.click()]);
    const lines = require("node:fs").readFileSync(await download.path(), "utf8").trim().split(/\r?\n/);
    check("Data & usage › Save as a spreadsheet: one line a day", (await download.suggestedFilename()) === "usage-report-30d.csv" && lines.length === days.length + 1, `${lines.length - 1} of ${days.length}`);
  } else check("Data & usage › Save as a spreadsheet: off with no day rows (nothing ran on this engine)", await csv.isDisabled());
  await closeDialog(page);
  /* Spend caps: one box per account that bills per use (none on a fresh engine), then Save caps. */
  const pools = (await api("accounts")).pools.filter((p) => p.kind === "api-key");
  await openPage(page, "usage");
  await page.locator('.set-col [data-act="capsb17"]').click(); await settle(page, 800);
  check("Data & usage › Spend caps: one box per account the engine bills per use", (await page.locator('.scrim input[id^="cap-b17-"]').count()) === pools.reduce((n, p) => n + p.accounts.length, 0));
  if (!pools.length) { check("Data & usage › Save caps: off with no such account", await page.locator('.scrim [data-act="capssaveb17"]').isDisabled()); await closeDialog(page); }
  else {
    const first = () => pools[0].accounts[0], capOf = async () => (await api("accounts")).pools.find((p) => p.pool === pools[0].pool).accounts.find((a) => a.id === first().id).monthlyCapUsd ?? null;
    const was = await capOf(), mode = (await api("accounts")).mode;
    /* While several accounts per connection is off, the engine refuses a cap in its own words. */
    if (mode === "off") {
      const no = await refusal("accounts/update", { pool: pools[0].pool, account: first().id, monthlyCapUsd: 7 });
      await page.locator(".scrim #cap-b17-0").fill("7"); await page.locator('.scrim [data-act="capssaveb17"]').click(); await settle(page, 1500);
      check("Data & usage › Save caps: the engine's words while several accounts is off", no && (await toastText(page)) === no, no ?? "");
      await closeDialog(page);
      await post("accounts/settings", { mode: "on" });
    }
    /* A cap is kept on a connection's list of accounts, which the engine starts when a second account is added. */
    let added = null;
    const listed = await refusal("accounts/update", { pool: pools[0].pool, account: first().id, monthlyCapUsd: was });
    if (listed) added = (await post("accounts/add", { pool: pools[0].pool, label: "Parity B5", key: "parity-b5-test-key-2" })).accounts?.find((a) => a.label === "Parity B5")?.id ?? null;
    await openPage(page, "usage");
    await page.locator('.set-col [data-act="capsb17"]').click(); await settle(page, 800);
    await page.locator(".scrim #cap-b17-0").fill("7"); await page.locator('.scrim [data-act="capssaveb17"]').click(); await settle(page, 1500);
    check("Data & usage › Save caps: the engine keeps the cap", (await capOf()) === 7, String(await capOf()));
    await page.locator('.set-col [data-act="capsb17"]').click(); await settle(page, 800);
    /* Putting back a higher cap or none raises it, so the engine's words are shown first and only the yes sends it. */
    const raise = was == null || was > 7 ? await refusal("accounts/update", { pool: pools[0].pool, account: first().id, monthlyCapUsd: was }) : null;
    await page.locator(".scrim #cap-b17-0").fill(was == null ? "" : String(was)); await page.locator('.scrim [data-act="capssaveb17"]').click(); await settle(page, 1500);
    if (raise) {
      check("Data & usage › Save caps: raising asks with the engine's words first", (await dlgText(page)) === raise && (await capOf()) === 7, raise);
      await page.locator('.scrim [data-act="capsloosenb17"]').click(); await settle(page, 1500);
    }
    check("Data & usage › Save caps: put back", (await capOf()) === was, String(await capOf()));
    if (added) await post("accounts/remove", { pool: pools[0].pool, account: added });
    if (mode === "off") await post("accounts/settings", { mode: "off" });
  }
  /* Flagged replies: the engine's list; sending one to the Branch team has no route, so that switch is greyed. */
  if (STUB.session) {
    const reply = (await api(`sessions/${STUB.session}`)).messages?.find((m) => m.role === "assistant");
    if (reply) await post("reply-flags", { sessionId: STUB.session, messageId: reply.messageId, reasons: ["wrong"] });
    await openPage(page, "usage");
  }
  const flags = (await api("reply-flags")).flags;
  check("Data & usage › Flagged replies: one row a flag", (await page.locator('.set-col [data-act="flforget17c"]').count()) === flags.length, String(flags.length));
  if (flags.length) {
    await page.locator(`.set-col [data-act="flforget17c"][data-v="${flags[0].id}"]`).click(); await settle(page, 1500);
    check("Data & usage › Flagged replies › Remove: the engine forgot it", !(await api("reply-flags")).flags.some((x) => x.id === flags[0].id));
  }
  check("Data & usage › Send a flagged reply: greyed", await greyed(page.locator("#fl-send-set17c")));
  /* Backups: Back up now is the engine's. */
  await openPage(page, "usage");
  const points = (await api("deployment/restore-points")).points.length;
  await page.locator('.set-col [data-act="demob17"][data-k="backup"]').click(); await settle(page, 1000);
  await page.locator('.scrim [data-act="demodob17"]').click(); await settle(page, 2500);
  check("Data & usage › Back up now: the engine kept one more", (await api("deployment/restore-points")).points.length === points + 1);
}

/* ---------- Branch itself, Models, Updates, People ---------- */
async function others(page) {
  await openPage(page, "self");
  const report = await api("deployment/doctor");
  await page.locator('.set-col [data-act="doctor"]').click();
  await page.locator(".scrim .tl li").first().waitFor({ timeout: 60000 });
  check("Branch itself › Check and fix: one line per check the engine ran", (await page.locator(".scrim .tl li").count()) === report.checks.length, String(report.checks.length));
  await closeDialog(page);
  /* The arena: its switch ships off, and the engine says so; switched on for this check, a round needs two connections. */
  const off = await refusal("reach/arena");
  await openPage(page, "models", "advanced");
  await page.locator('.set-col [data-act="arenab17"]').click(); await settle(page, 1200);
  check("Models › Open the arena: the engine's words while it is off", off && (await toastText(page)) === off, off ?? "");
  await post("reach/switch", { part: "arena", mode: "on" });
  await page.locator('.set-col [data-act="arenab17"]').click(); await settle(page, 1200);
  check("Models › Open the arena: asks for the question", (await page.locator(".scrim #arena-q17").count()) === 1);
  await page.locator(".scrim #arena-q17").fill("Parity B5 check");
  const two = await refusal("reach/arena/start", { prompt: "Parity B5 check" });
  await page.locator('.scrim [data-act="arenaaskb17"]').click(); await settle(page, 2500);
  const board = (await api("reach/arena")).leaderboard;
  if (board.length < 2) check("Models › Ask two models: the engine's words with fewer than two connections", two && (await toastText(page)) === two, two ?? "");
  else {
    await page.locator(".scrim .ans-b17").first().waitFor({ timeout: 60000 });
    check("Models › Ask two models: two answers without names", (await page.locator(".scrim .ans-b17").count()) === 2 && !(await page.locator(".scrim .ans-b17 small").first().textContent()).includes("·"));
    const before = (await api("reach/arena")).leaderboard.reduce((n, m) => n + m.games, 0);
    await page.locator('.scrim [data-act="arenavoteb17"][data-v="a"]').click(); await settle(page, 1500);
    const after = (await api("reach/arena")).leaderboard;
    check("Models › A is better: the engine counted the vote", after.reduce((n, m) => n + m.games, 0) === before + 2);
    check("Models › After the vote: the names and the standings", (await page.locator(".scrim .ans-b17 small").first().textContent()).includes("·") && (await page.locator(".scrim .elo-b17 span").count()) === after.length);
    await page.locator('.scrim [data-act="arenanextb17"]').click(); await settle(page, 500);
    check("Models › Next pair: asks for the next question", (await page.locator(".scrim #arena-q17").count()) === 1);
  }
  await closeDialog(page);
  await post("reach/switch", { part: "arena", mode: "off" });
  /* Updates: what removing Branch would take away, from the engine's survey (which only looks). */
  const plan = await post("remove-branch/plan", { keepConversations: true });
  // Where the engine names the lines to paste, the plain steps say what the Windows note said (verify-remove-branch.cjs).
  const steps = Boolean((await api("deployment")).uninstall);
  await openPage(page, "updates");
  const rows = await page.locator(".set-col .danger8 .prow").count();
  check("Updates › What removing Branch takes away: the engine's survey", rows === plan.items.filter((x) => x.goes && x.bytes > 0).length
    && (!plan.instead || steps || (await page.locator(".set-col .danger8 .hint").first().textContent()) === plan.instead), plan.instead ?? `${rows} rows`);
  /* The owner saw the old app's Updates page print its section's description twice; the new page must not, at any level. */
  for (const lv of ["regular", "advanced", "technical"]) {
    await openPage(page, "updates", lv);
    const lines = (await page.locator(".set-col").innerText()).split(/\n/).map((x) => x.trim()).filter((x) => x.length > 20);
    const twice = lines.filter((x, i) => lines.indexOf(x) !== i);
    check(`Updates (${lv}): no line printed twice`, twice.length === 0, twice.join(" | "));
  }
  /* Send traces elsewhere › Send a test trace: the engine's own answer (it refuses while sending is off). */
  const traced = await refusal("tracing/test", {});
  await openPage(page, "developer");
  await page.locator('.set-col [data-act="demob17"][data-k="tracing"]').click();
  await page.locator('.scrim [data-act="demodob17"]').waitFor({ timeout: 15000 });
  await page.locator('.scrim [data-act="demodob17"]').click(); await settle(page, 1500);
  check("Developer › Send a test trace: the engine's answer", traced ? (await toastText(page)) === traced : (await toastText(page)).length > 0, traced ?? await toastText(page));
  await closeDialog(page);
  /* People: everyone here is under On this computer until someone signs in on a device of their own. */
  const people = await api("people/settings").catch(() => ({ people: [] }));
  await openPage(page, "people");
  const own = (people.people ?? []).filter((p) => (p.signedIn ?? []).length).length;
  check("People › On their own device: drawn only for people signed in on one", (await page.locator('.set-col .grp8').count()) === 1 + (own ? 1 : 0), String(own));
  /* Every Settings page opened is told to the engine once (achievements on). */
  const got = (await api("delight/achievements")).list.filter((a) => /^noticed:pages:/.test(a.id) && a.got).map((a) => a.id);
  check("Settings pages are told to the engine for achievements", got.includes("noticed:pages:3"), got.join(", "));
}

/* ---------- every page, every level: drawn with no page error; what stays greyed is counted ---------- */
async function sweep(page, label) {
  const ids = ["general", "people", "appearance", "notifications", "instructions", "models", "accounts", "local", "voice", "chatapps", "permissions", "computer", "secrets", "usage", "gateway", "self", "updates", "achievements", "advanced", "developer"];
  for (const lv of ["regular", "advanced", "technical"]) {
    for (const id of ids) {
      if ((id === "advanced" && lv === "regular") || (id === "developer" && lv !== "technical")) continue;
      await openPage(page, id, lv);
      const soon = await page.locator(".set-col .soon").count();
      if (lv === "technical") console.log(`      ${label} ${id}: ${soon} greyed`);
      if (SHOTS && lv === "technical") await page.screenshot({ path: `${SHOTS}/${label}-${id}.png`, fullPage: true });
    }
  }
}

/* STUBS=1: two stand-in model services on this computer (stub-model-b5.cjs, on LM Studio's and Jan's own local ports,
   which must be free), connected with made-up test keys, and one task run, so the arena, spend caps, the report's
   spreadsheet and a flagged reply can be pressed for real. Only for a throwaway engine. */
const STUB = { session: null, servers: [] };
async function stubs() {
  if (process.env.STUBS !== "1") { console.log("      (STUBS=1 adds two stand-in model services so the arena, caps, spreadsheet and flag removal are pressed too)"); return; }
  const { start } = require("./stub-model-b5.cjs");
  for (const [provider, port] of [["lm-studio", 1234], ["jan", 1337]]) {
    STUB.servers.push(await start(port));
    await post("connections/from-preset", { provider, key: `parity-b5-test-${provider}`, model: "stub-model" });
  }
  STUB.session = (await post("run", { prompt: "Parity B5 check" })).sessionId;
}

(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  await stubs();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const label = process.env.LABEL ?? "user";
  await general(page);
  await permissions(page);
  await usage(page);
  await others(page);
  await demos(page);
  await sweep(page, label);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  for (const server of STUB.servers) server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
