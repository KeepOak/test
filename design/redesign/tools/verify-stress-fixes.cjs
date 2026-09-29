/* The owner's stress test (B001–B008), proved in the real window against a FRESH engine: every switched-off message comes
   with its switch, each switch read back through the engine's own GET route; greyed controls say why. Page errors: zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-stress-fixes.mjs
     BRANCH_DATA_DIR=<same> BRANCH_WORKSPACE=<same> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> DATA=<same data dir> [SHOTS=<dir>] node design/redesign/tools/verify-stress-fixes.cjs
   The Trunk's "Which model" row is also drawn at 1440 and 390 wide, light and dark: its select never overlaps its own
   label or hint (screenshots go to SHOTS when given). */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const { PORT, TOKEN, DATA, SHOTS } = process.env;
if (!PORT || !TOKEN || !DATA) { console.error("Set PORT, TOKEN and DATA."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE = JSON.parse(fs.readFileSync(path.join(DATA, "verify-stress-fixes.json"), "utf8"));
const TIDY = "0b9a1d7e-5c41-4f2a-9e3b-6d2f8a71d905";
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await sleep(200); } }
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => { const b = document.createElement("button"); b.dataset.act = n; Object.assign(b.dataset, d); document.getElementById("app").appendChild(b); b.click(); b.remove(); }, [name, data]);
  await sleep(700);
}
const tab = (page, place, v) => act(page, "view", { v: place, tab: v });
const soonTip = "Coming soon";

async function b001(page) {
  // Recordings ship on now (src/run-recording.ts recordingShipsAs), so the off path is set up through the engine first.
  await api("recordings", { mode: "off" });
  await page.reload();
  await page.waitForSelector("#main", { timeout: 15000 });
  await tab(page, "inbox", "history");
  const tile = page.locator('#main [data-off="recordings"]');
  check("B001 History says recordings are off, with the switch", await until(async () => (await tile.count()) === 1) && (await tile.locator('[data-act="switch-on"]').count()) === 1);
  check("B001 and says a task that ran before can be played", (await tile.textContent()).includes("tasks that ran before"));
  await page.click(`#main [data-act="replay"][data-id="${NOTE.run}"]`);
  const inDlg = page.locator('.dlg [data-off="recordings"]');
  check("B001 Watch again while off: the engine's sentence and the switch, not a lone toast", await until(async () => (await inDlg.count()) === 1) && (await inDlg.textContent()).includes("Recordings of tasks are switched off"));
  await inDlg.locator('[data-act="switch-on"]').click();
  check("B001 the switch: GET /api/recordings reads when-needed", await until(async () => (await api("recordings")).settings.mode === "when-needed"));
  check("B001 the same task, which ran while off, now plays", await until(async () => (await page.locator(".dlg .replay6").count()) === 1) && (await api(`runs/${NOTE.run}/recording`)).frames.length > 0);
  await act(page, "dlg-close");
  check("B001 History's tile goes once on", await until(async () => (await tile.count()) === 0));
}

async function b002(page) {
  for (const [v, a] of [["scheduled", "nl-add"], ["triggers", "trig-add"]]) {
    await tab(page, "automations", v);
    const add = page.locator(`#main [data-act="${a}"]`);
    check(`B002 ${v}: Add waits while the box is empty`, await add.isDisabled());
    await page.fill("#nl-in", "every Friday at 5, tidy Downloads");
    check(`B002 ${v}: words make Add pressable`, !(await add.isDisabled()));
    await page.fill("#nl-in", "");
    check(`B002 ${v}: cleared, it waits again`, await add.isDisabled());
  }
}

async function b003(page) {
  await tab(page, "automations", "scheduled");
  await page.click('#main [data-act="ordersb17"]');
  await page.waitForSelector("#order-in-b17", { timeout: 5000 });
  const add = page.locator('.dlg [data-act="orderaddb17"]');
  check("B003 Add it and its box are live, and the dialog says what Add it does", (await add.getAttribute("aria-disabled")) !== "true" && !(await page.locator("#order-in-b17").isDisabled()) && (await page.locator(".dlg").textContent()).includes("kept only after your yes"));
  await add.click();
  check("B003 with no words, the box is focused and nothing opens", await page.evaluate(() => document.activeElement?.id === "order-in-b17"));
  await page.fill("#order-in-b17", "when a bill arrives, file it");
  await add.click();
  check("B003 Add it: a new conversation with the words in the box, not sent", await until(async () => (await page.inputValue("#prompt")).includes("when a bill arrives, file it")) && (await api("state")).runs.length === 1);
}

async function b004(page) {
  const { tools } = await api("tools");
  const words = tools.find((x) => x.name === "memory.tidy").description;
  await tab(page, "automations", "procedures");
  await page.click(`#main [data-act="flow"][data-id="${TIDY}"]`);
  await page.waitForSelector(".dlg #ft-0", { timeout: 5000 });
  check("B004 the step reads as the engine's description, not raw JSON", (await page.inputValue(".dlg #ft-0")) === words && !(await page.locator(".dlg").textContent()).includes('{"stage"'));
  const text = await page.locator(".dlg").textContent();
  check("B004 proposed is explained, and where Tidy my memory runs", text.includes("not yet checked") && text.includes("Library › Memory"));
  const tips = await page.$$eval(".dlg [disabled], .dlg [aria-disabled=true]", (els) => els.map((e) => e.dataset.tip || ""));
  check("B004 every greyed control says why (none says Coming soon)", tips.length > 0 && tips.every((w) => w && w !== soonTip), tips.join(" | "));
  await page.click('.dlg [data-act="flow-memory"]');
  check("B004 Open Memory goes to Library › Memory", await until(async () => (await page.locator(".dlg").count()) === 0 && (await page.locator("#main h1").textContent()).length > 0));
}

async function b005(page) {
  // Saved prompts ship on now (src/prompt-library.ts promptLibraryShipsAs): switched off through the engine first.
  await api("prompts/settings", { mode: "off" });
  await page.reload();
  await page.waitForSelector("#main", { timeout: 15000 });
  await tab(page, "automations", "procedures");
  const tile = page.locator('#main [data-off="prompts"]');
  check("B005 saved prompts: off, said before the form, with the switch", await until(async () => (await tile.count()) === 1) && await page.locator('#main [data-act="prompt-new"]').isDisabled());
  await tile.locator('[data-act="switch-on"]').click();
  check("B005 the switch: GET /api/prompts reads when-needed", await until(async () => (await api("prompts")).settings.mode === "when-needed"));
  check("B005 New prompt is pressable once on", await until(async () => !(await page.locator('#main [data-act="prompt-new"]').isDisabled())));
  await page.click('#main [data-act="prompt-new"]');
  await page.waitForSelector(".dlg #pr-name", { timeout: 5000 });
  const save = page.locator('.dlg [data-act="prompt-save"]');
  check("B005 Save waits for a name and what to ask, and says so", await save.isDisabled() && (await page.locator(".dlg #pr-need").isVisible()));
  await page.fill(".dlg #pr-name", "Monday notes");
  check("B005 a name alone is not enough", await save.isDisabled());
  await page.fill(".dlg #pr-text", "Summarise the notes from {{day}}");
  check("B005 both filled: Save is pressable", !(await save.isDisabled()));
  await save.click();
  check("B005 Save saves it (GET /api/prompts)", await until(async () => (await api("prompts")).prompts.some((p) => p.title === "Monday notes")));
}

async function b006(page) {
  await tab(page, "automations", "triggers");
  const tile = page.locator('#main [data-off="procedures"]');
  check("B006 Triggers: procedures that start themselves are off, said with the switch and why", await until(async () => (await tile.count()) === 1) && (await tile.textContent()).includes("starts after one of your tasks finishes"));
  await tile.locator('[data-act="switch-on"]').click();
  const yes = page.locator('.dlg [data-act="switch-on-yes"]');
  check("B006 switching procedures on shows the engine's loosening words first", await until(async () => (await yes.count()) === 1) && (await page.locator(".dlg").textContent()).includes("This makes Branch less careful: procedures would start by themselves"));
  check("B006 nothing switched before the yes", (await api("autonomy")).modes.procedures === "off");
  await yes.click();
  check("B006 the switch: GET /api/autonomy reads procedures when-needed", await until(async () => (await api("autonomy")).modes.procedures === "when-needed"));
  check("B006 the tile goes once on", await until(async () => (await tile.count()) === 0));
}

async function b007(page) {
  await tab(page, "automations", "board");
  const tile = page.locator('#main [data-off="board"]');
  check("B007 Board: the engine's sentence with the switch", await until(async () => (await tile.count()) === 1) && (await tile.textContent()).includes("switched off"));
  await tile.locator('[data-act="switch-on"]').click();
  check("B007 the switch: GET /api/flows-boards reads kanban when-needed", await until(async () => (await api("flows-boards")).modes.kanban === "when-needed"));
  check("B007 the board's columns are drawn once on", await until(async () => (await page.locator("#main .board15").count()) === 1));
}

/* No overlap between the row's label, hint and its select, at this size and scheme. */
async function modelRowFits(page, width, scheme) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
  await sleep(400);
  const row = page.locator(".dlg .tm-model18");
  await row.scrollIntoViewIfNeeded();
  const boxes = await row.evaluate((el) => ["b", ".gsel", "small", ".tm-why"].map((q) => { const r = el.querySelector(q)?.getBoundingClientRect(); return r ? [r.left, r.top, r.right, r.bottom] : null; }));
  const [b, sel, small, why] = boxes;
  const hit = (x, y) => x && y && x[0] < y[2] && y[0] < x[2] && x[1] < y[3] && y[1] < x[3];
  const bg = await page.locator(".dlg #tm-model-sel").evaluate((el) => getComputedStyle(el).backgroundColor);
  if (SHOTS) await row.screenshot({ path: path.join(SHOTS, `trunk-model-${width}-${scheme}.png`) });
  check(`B008 Which model at ${width} ${scheme}: select clear of label, hint and reason; solid surface`, sel && !hit(sel, b) && !hit(sel, small) && !hit(sel, why) && !/rgba\(.*, 0\)|transparent/.test(bg), `${JSON.stringify(boxes)} ${bg}`);
}

/* B008 as the engine now has it: a connection is greyed for a Trunk only when the engine says this caller may not use it
   (models.presets[].trunkUse ok:false, with its reason). The owner's own Trunk may use a sign-in, so for the owner nothing
   is greyed and the pick saves. A household person gets ok:false with the reason, when the engine gives trunkUse at all
   (claude/trunks-use-subscriptions); without it nothing is greyed ahead and the engine's refusal after sending is the
   fallback. Nothing here sends through a real sign-in: a message is sent only while the engine refuses it. */
async function b008(page) {
  await api("providers/cli-agents", { id: "claude-code" });
  const owners = (await api("state")).models.presets.find((p) => p.id === "cli-claude-code");
  const answers = owners?.trunkUse !== undefined;
  check("B008 engine: no bare sign-in mark; for the owner, trunkUse is ok or not given", owners?.signIn === undefined && (!answers || owners.trunkUse.ok === true), JSON.stringify(owners?.trunkUse));
  const { trunk } = await api("trunks", { name: "Trunk 3" });
  await page.reload();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1200);
  await act(page, "edit", { id: trunk.id });
  await act(page, "st-tab", { v: "may" });
  const option = (await gselChoices(page.locator(".dlg #tm-model-sel"))).find((c) => c.value === "cli-claude-code");
  check("B008 the owner's Trunk: the sign-in model is offered, not greyed", !!option && !option.off);
  check("B008 the owner's Trunk: no reason line, nothing refused", (await page.locator(".dlg .tm-model18 .tm-why").count()) === 0);
  for (const width of [1440, 390]) for (const scheme of ["light", "dark"]) await modelRowFits(page, width, scheme);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await pickGsel(page.locator(".dlg #tm-model-sel"), "cli-claude-code");
  check("B008 the owner picks it for the Trunk (GET /api/trunks model)", await until(async () => ((await api("trunks")).trunks ?? []).find((x) => x.id === trunk.id)?.model === "cli-claude-code"));
  await act(page, "dlg-close");

  if (!answers) {
    await act(page, "chat", { id: trunk.chatSessionId });
    const runsBefore = (await api("state")).runs.length;
    await page.fill("#prompt", "are you able to edit your settings?");
    await page.keyboard.press("Enter");
    check("B008 no answer from the engine: nothing held ahead, the message is sent", await until(async () => (await api("state")).runs.length > runsBefore));
    check("B008 the engine's refusal after sending is said in the conversation", await until(async () => page.evaluate(() => document.body.innerText.includes("A Trunk never answers through a sign-in account"))));
  } else {
    await api("people/settings", { mode: "on" });
    const profile = await api("profiles", { name: "Sam", pin: "2468" });
    await api("profiles/switch", { profileId: profile.id, pin: "2468" });
    const sams = (await api("state")).models.presets.find((p) => p.id === "cli-claude-code");
    check("B008 a household person: trunkUse ok:false with the engine's reason", sams?.trunkUse?.ok === false && !!sams.trunkUse.reason, JSON.stringify(sams?.trunkUse));
    await page.reload();
    await page.waitForSelector("#main", { timeout: 15000 });
    await sleep(1200);
    // A Trunk is the owner's: a household person is not given its editor, and the engine says why.
    await act(page, "edit", { id: trunk.id });
    check("B008 a household person: the owner's Trunk opens no editor, and says whose it is",
      (await page.locator(".dlg .tm-model18").count()) === 0 && /belongs to the owner/.test((await page.locator(".toast").first().textContent().catch(() => "")) ?? ""));
    await act(page, "dlg-close");
    await api("profiles/switch", { profileId: null });
  }
  await api(`trunks/${encodeURIComponent(trunk.id)}`, { model: "" });
  await api("connections/forget", { id: "cli-claude-code" });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#main", { timeout: 15000 });
    await sleep(1200);
    for (const step of [b001, b002, b003, b004, b005, b006, b007, b008]) {
      try { await step(page); } catch (error) { check(`${step.name} ran to the end`, false, error.message.split("\n")[0]); }
    }
    check("no page or console errors", errors.length === 0, errors.join("; "));
  } finally { await browser.close(); }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();
