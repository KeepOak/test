// Verifies claude/finish-soon-a: every control this branch took out of "Coming soon" is clicked with the real mouse in the
// real window, and each change is read back through the engine's own GET route. Two engines:
//   1. The reviewer's throwaway engine (PORT, TOKEN): fresh data, NO model. It proves the controls that need no model, and
//      that the ones that need one say so in the engine's words and save nothing.
//        BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
//        PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-finish-soon-a.cjs
//   2. A second engine started here in-process with a scripted test model (its own temp folder, a free port), as the
//      other verify tools do: words to a trigger, writing a skill, a saved recipe's steps, removing another agent and
//      removing a plugin installed as an add-on package.
// Page errors must be zero, and nothing in this branch's share may still show "Coming soon".
// Screenshots: C:/Users/bishi/AppData/Local/Temp/claude-session-files/finish-soon-a/
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/finish-soon-a";
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await pause(200); } }

function client(base, token) {
  const call = async (path, body, key = token) => {
    const res = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const api = async (path, body) => { const r = await call(path, body); if (r.status >= 400) throw new Error(`${path}: ${r.status} ${r.body.error ?? ""}`); return r.body; };
  return { call, api };
}

/* ---------- the window ---------- */
async function signIn(page, base, token, api) {
  await api("onboarding", { done: true });
  await page.goto(base + "/");
  await page.getByLabel("Session token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator('.side-nav [data-act="view"]').first().waitFor();
}
const place = async (page, v) => { await page.locator(`.side-nav [data-act="view"][data-v="${v}"]`).first().click(); await pause(300); };
const tab = async (page, where, v) => { await page.locator(`[data-act="ptab"][data-place="${where}"][data-v="${v}"]`).first().click(); await pause(400); };
const toastText = async (page) => (await until(async () => (await page.locator(".toast").first().innerText()) || null, 8000)) ?? "";
/* The last toast is taken away first, so the words read after a click are that click's. */
const clearToast = (page) => page.evaluate(() => document.querySelector(".toast")?.remove());
/* Nothing in the scope is greyed as Coming soon. */
async function noSoon(page, scope, what) {
  const n = await page.locator(`${scope} .soon, ${scope} [data-tip="Coming soon"]`).count();
  check(`${what}: nothing shows Coming soon`, n === 0, n ? `${n} greyed` : "");
}
/* Exactly `want` controls match the selector, and every one is drawn greyed as Coming soon. */
async function allSoon(page, sel, what, want) {
  const all = page.locator(sel), n = await all.count();
  let grey = 0;
  for (let i = 0; i < n; i++) if ((await all.nth(i).getAttribute("class"))?.includes("soon") && (await all.nth(i).isDisabled())) grey++;
  check(`${what}: drawn greyed (Coming soon)`, n === want && grey === n, `${grey} of ${n} greyed, ${want} drawn in the prototype`);
}
/* Types into a box with the keyboard until it holds the words (a place may be drawn again once as it settles). */
async function typeInto(page, sel, words) {
  await until(async () => { await page.locator(sel).fill(""); await page.locator(sel).click(); await page.keyboard.type(words); await pause(300); return (await page.locator(sel).inputValue()) === words; });
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
async function settingsPage(page, id) {
  await page.locator('.owner-row [data-act="view"][data-v="settings"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await pause(500);
}

/* ---------- 1. the no-model engine ---------- */

/* flow-run: Run on a procedure that asks before it starts puts that question in the ledger. */
async function flowRun(page, api, proc) {
  await place(page, "automations");
  await tab(page, "automations", "procedures");
  await page.locator(`[data-act="flow"][data-id="${proc.id}"]`).click();
  await page.locator('.dlg [data-act="flow-run"]').waitFor();
  await noSoon(page, ".dlg", "the procedure editor");
  await clearToast(page);
  await page.locator('.dlg [data-act="flow-run"]').click();
  const said = await toastText(page);
  const asked = await until(async () => (await api("autonomy/ledger?status=pending")).entries.find((e) => e.kind === "start" && e.payload?.procedureId === proc.id));
  check("flow-run", !!asked, `GET /api/autonomy/ledger: "${asked?.title}" waits; the toast says "${said}"`);
  await shot(page, "flow-run");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

/* Schedule card "Who does it": a Trunk picked, Confirm makes it that Trunk's routine with the card's days. */
async function whoDoesIt(page, api, trunk) {
  await tab(page, "automations", "scheduled");
  await typeInto(page, "#nl-in", "every weekday at 8, check my inbox for invoices");
  await page.locator('[data-act="nl-add"]').click();
  await page.locator(".prop17d").waitFor();
  await noSoon(page, ".prop17d", "the schedule card");
  const pick = page.locator(`.prop17d [data-act="ppset17d"][data-k="trunk"][data-v="${trunk.id}"]`);
  await pick.click();
  check("ppset17d trunk (pressed)", (await pick.getAttribute("aria-pressed")) === "true", "the Trunk is pressed on the card");
  await shot(page, "schedule-who");
  await page.locator('.prop17d [data-act="ppok17d"]').dblclick(); // fix399: a double press saves once
  const made = await until(async () => (await api("schedules")).schedules.find((s) => String(s.data.prompt).startsWith(`[Trunk @${trunk.handle}]`)));
  await pause(1500);
  const saves = (await api("schedules")).schedules.filter((s) => String(s.data.prompt).startsWith(`[Trunk @${trunk.handle}]`)).length;
  check("ppok17d pressed twice saves one routine", saves === 1, `GET /api/schedules: ${saves}`);
  const routine = await until(async () => (await api(`trunks/${trunk.id}`)).routines.find((r) => r.id === made?.id));
  check("Who does it → the Trunk's routine", made && routine && JSON.stringify(made.data.weekdays) === "[1,2,3,4,5]" && made.data.dailyAt === "08:00",
    `GET /api/trunks/<id> lists routine "${routine?.name}"; GET /api/schedules: weekdays ${JSON.stringify(made?.data.weekdays)} at ${made?.data.dailyAt}`);
}

/* fix399: the schedule card's Who does it lists five Trunks, as the prototype does, however many there are. */
async function whoFive(page, api, stamp) {
  for (let i = 0; i < 5; i++) await api("trunks", { name: `Extra ${i} ${stamp}` });
  await tab(page, "automations", "triggers");
  await tab(page, "automations", "scheduled");
  await page.evaluate(() => import("/app/core/state.js").then((m) => m.refresh()));
  await typeInto(page, "#nl-in", "every day at 9, tidy the notes folder");
  await page.locator('[data-act="nl-add"]').click();
  await page.locator(".prop17d").waitFor();
  const n = await page.locator('.prop17d [data-act="ppset17d"][data-k="trunk"]').count(), all = (await api("trunks")).trunks.length;
  check("Who does it lists five Trunks", n === 5 && all > 5, `${n} drawn of ${all}`);
  await page.locator('.prop17d [data-act="ppno17d"]').click();
}

/* fix399: a program the launch file names has no route that removes it, so its Remove is drawn greyed. */
async function launchRemoveGreyed(page) {
  await place(page, "customize");
  await tab(page, "customize", "tools");
  await page.locator('[data-act="t9-kind"][data-v="clis"]').click();
  await page.locator('[data-act="t9-sel"][data-v="git"]').click();
  const rm = page.locator('.t9-detail [data-act="tool-rm"]');
  check("a launch-file program's Remove is drawn greyed", (await rm.count()) === 1 && (await rm.getAttribute("class")).includes("soon") && (await rm.isDisabled()), "Customize › Tools › git");
}

/* Triggers "Describe it" with no model: the engine's refusal, and nothing saved. */
async function triggerNoModel(page, api) {
  await tab(page, "automations", "triggers");
  await noSoon(page, "form.nl", "the triggers box");
  const before = (await api("state")).triggers?.length ?? 0;
  await typeInto(page, "#nl-in", "when the shop's form gets a submission, summarise it");
  await clearToast(page);
  await page.locator('[data-act="trig-add"]').click();
  const said = await toastText(page);
  check("trig-add (no model)", /No model yet/.test(said) && (await page.locator(".prop17d").count()) === 0 && ((await api("state")).triggers?.length ?? 0) === before,
    `the engine's words: "${said}"; no card, GET /api/state triggers unchanged`);
}

async function openAddSkill(page) {
  await place(page, "customize");
  await tab(page, "customize", "tools");
  await page.locator('[data-act="t9-kind"][data-v="skills"]').click();
  await page.locator('.t9-addbtn[data-act="tool-add"][data-v="skills"]').click();
  await page.locator('.dlg [data-act="sk-write"]').click();
  await page.locator("#sk-what").waitFor();
}

/* Write one with Branch with no model: the engine says so; Add skill stays disabled; nothing installed. */
async function skillNoModel(page, api) {
  await openAddSkill(page);
  await noSoon(page, ".dlg", "Write a skill with Branch");
  check("sk-save waits for a draft", await page.locator('.dlg [data-act="sk-save"]').isDisabled(), "Add skill is disabled until there is a draft");
  await typeInto(page, "#sk-what", "Every Friday, check the price list and tell me if paper went up.");
  await clearToast(page);
  await page.locator('.dlg [data-act="sk-draft"]').click();
  const said = await toastText(page);
  check("sk-draft (no model)", /No model yet/.test(said) && ((await api("state")).skills ?? []).length === 0 && await page.locator('.dlg [data-act="sk-save"]').isDisabled(),
    `the engine's words: "${said}"; GET /api/state skills empty; Add skill still disabled`);
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

/* Whose files: a Trunk's own SOUL, written and saved through the Trunk's own route. */
async function ifOwner(page, api, trunk, stamp) {
  await settingsPage(page, "instructions");
  const chip = page.locator(`#main [data-act="if-owner"][data-v="${trunk.id}"]`);
  await chip.click();
  await pause(300);
  await noSoon(page, "#main", "Instructions & personality");
  check("if-owner", (await chip.getAttribute("aria-pressed")) === "true" && (await page.locator('#main [data-act="if-open"]').count()) === 1,
    "the Trunk is pressed; only its SOUL row has an Edit, the others use the shared one");
  await page.locator('#main [data-act="if-open"][data-f="soul"]').click();
  await page.locator("#if-text").click();
  const words = `Answer in short lists. ${stamp}`;
  await page.keyboard.type(words);
  await page.locator('.dlg [data-act="if-save"]').click();
  const saved = await until(async () => (await api(`trunks/${trunk.id}`)).trunk.instructions.includes(stamp));
  check("if-save (a Trunk's SOUL)", saved, "GET /api/trunks/<id>: its instructions hold the words typed");
  await shot(page, "if-owner");
  await page.locator('#main [data-act="if-owner"][data-v="branch"]').click();
}

/* Pairing a computer, then Name your new computer: the glyph, the colour and the name, read back from GET /api/devices. */
async function nameDevice(page, api, call, stamp) {
  await settingsPage(page, "computer");
  await page.locator('#main [data-act="comp-add"]').click();
  await page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]').click();
  await page.locator('.dlg .ko-code, .dlg [data-act="pair-on"]').first().waitFor();
  const on = page.locator('.dlg [data-act="pair-on"]');
  if (await on.count()) await on.click();
  await page.locator(".dlg .ko-code").waitFor();
  const code = (await page.locator(".dlg .ko-code").innerText()).replace(/\D/g, "");
  const offer = /offer=([a-f0-9]{32})/.exec(await page.locator(".dlg .pair-cmd15").innerText())?.[1];
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const answer = await call("devices/pair", { offer, code, name: `BOX-${stamp}`, platform: "linux", publicKey }, null);
  if (answer.status !== 200) throw new Error(`the stand-in computer could not answer: ${answer.status}`);
  await page.locator("#pair-match").waitFor({ timeout: 8000 });
  await page.locator("#pair-match").check();
  await page.locator('.dlg [data-act="pair-letin"]').click();
  await page.locator("#dev-name").waitFor();
  await noSoon(page, ".dlg", "Name your new computer");
  await page.locator('.dlg [data-act="dev-glyph"][data-v="server"]').click();
  check("dev-glyph", (await page.locator('.dlg [data-act="dev-glyph"][data-v="server"]').getAttribute("aria-pressed")) === "true", "Server is pressed");
  await page.locator('.dlg [data-act="dev-col"][data-v="#5E8C4A"]').click();
  check("dev-col", (await page.locator('.dlg [data-act="dev-col"][data-v="#5E8C4A"]').getAttribute("aria-pressed")) === "true", "the green swatch is pressed");
  await page.locator("#dev-name").fill(`Studio ${stamp}`);
  await shot(page, "name-device");
  await page.locator('.dlg [data-act="dev-save"]').click();
  const device = await until(async () => (await api("devices")).devices.find((d) => d.name === `Studio ${stamp}`));
  check("dev-save", device?.glyph === "server" && device?.color === "#5E8C4A", `GET /api/devices: "${device?.name}", glyph ${device?.glyph}, colour ${device?.color}`);
  const card = page.locator(`#main .comp7-card:has-text("Studio ${stamp}") .ico-tile`);
  await card.waitFor({ timeout: 8000 });
  const color = await card.evaluate((el) => getComputedStyle(el).color);
  check("Settings › Computer draws it with its look", /94, 140, 74/.test(color) && (await card.locator("rect").count()) === 2, `the card's tile is ${color}, with the server glyph`);
}

/* Neither greyed control that stays is drawn anywhere: ac-pair (no network discovery) and team-invite-go (superseded). */
async function notDrawn(page) {
  await page.locator('.side-nav [data-act="view"]').first().waitFor();
  for (const act of ["ac-pair", "team-invite-go"]) check(`${act} is not drawn`, (await page.locator(`[data-act="${act}"]`).count()) === 0);
}

/* ---------- 2. the scripted engine ---------- */
const SKILL = (stamp) => `---\nname: paper-watch-${stamp}\ndescription: Use when the owner wants the price list checked for paper.\n---\n\n# Paper watch\n\n## Steps\n1. Open the price list.\n2. Tell the owner if paper went up.\n`;
function scripted(stamp) {
  let trigger = null;
  return {
    setTrigger(value) { trigger = value; },
    provider: { name: "scripted", async complete(request) {
      const said = JSON.stringify(request.messages ?? []);
      if (said.includes("Say which event starts it")) return { content: JSON.stringify(trigger), toolCalls: [] };
      if (said.includes("write one skill file")) return { content: SKILL(stamp), toolCalls: [] };
      return { content: "ok", toolCalls: [] };
    } },
  };
}

/* The card, or the engine's words when it refused. */
async function cardOrSaid(page) {
  await page.locator(".prop17d, .toast").first().waitFor();
  if (!(await page.locator(".prop17d").count())) throw new Error(`no card: ${await toastText(page)}`);
}

async function triggersScripted(page, api, model) {
  await place(page, "automations");
  await tab(page, "automations", "triggers");
  const describe = async (words) => {
    await clearToast(page);
    // The tab may still be drawn again as it settles; the words are typed until the box holds them.
    // If the place was drawn again between the typing and the click, the box is empty and Add does nothing: type again.
    for (let i = 0; i < 3; i++) {
      await typeInto(page, "#nl-in", words);
      await page.locator('[data-act="trig-add"]').click();
      if (await page.locator(".prop17d, .toast").first().waitFor({ timeout: 5000 }).then(() => true, () => false)) return;
    }
  };
  const procedures = async () => (await api("autonomy/procedures")).procedures;
  model.setTrigger({ kind: "task", when: "when a task about invoices finishes", what: "file the result", name: "File invoices", words: "invoices" });
  await describe("when a task about invoices finishes, file the result");
  await cardOrSaid(page);
  await noSoon(page, ".prop17d .pp-g17d", "the trigger card's fields");
  await noSoon(page, ".prop17d .acts", "the trigger card's Cancel and Confirm");
  await allSoon(page, ".prop17d .seg button", "the trigger card's Who does it (a procedure has no field for a Trunk)", 1);
  check("trig-add (the card)", (await page.locator("#pp-when17d").inputValue()) === 'after a task about "invoices" finishes' && (await procedures()).length === 0,
    "the card shows the engine's reading; GET /api/autonomy/procedures is still empty");
  await page.locator("#pp-twhat17d").fill("file the result in Library");
  await shot(page, "trigger-card");
  await page.locator('[data-act="trig-ok"]').dblclick(); // fix399: a double press saves once
  const savedSaid = await toastText(page);
  const proc = await until(async () => (await procedures()).find((p) => p.procedure.name === "File invoices"));
  await pause(1500);
  const saves = (await procedures()).filter((p) => p.procedure.name === "File invoices").length;
  check("trig-ok pressed twice saves one procedure", saves === 1, `GET /api/autonomy/procedures: ${saves}`);
  check("trig-ok (a finished task)", proc?.procedure.start.kind === "after-task" && proc.procedure.start.words === "invoices" && proc.procedure.steps[0].prompt === "file the result in Library",
    `GET /api/autonomy/procedures: starts ${proc?.starts}, with the words as changed; the toast says "${savedSaid}"`);

  model.setTrigger({ kind: "app", when: "When the shop's form gets a submission", what: "summarise it", name: "Form summary", words: "" });
  await describe("when the shop's form gets a submission, summarise it");
  const appSaid = await toastText(page);
  check("trig-add (an app's message)", /trigger address and its secret/.test(appSaid) && (await page.locator(".prop17d").count()) === 0 && (await api("triggers")).triggers.length === 0,
    `the engine's words: "${appSaid}"; GET /api/triggers empty`);

  model.setTrigger({ kind: "none", when: "When a PDF lands in Downloads", what: "summarise it", name: "PDF", words: "" });
  await describe("when a PDF lands in Downloads, summarise it");
  const said = await toastText(page);
  check("trig-add (what the engine cannot watch)", /cannot watch/.test(said) && (await page.locator(".prop17d").count()) === 0, `the engine's words: "${said}"`);

  model.setTrigger({ kind: "task", when: "when any task finishes", what: "tell me", name: "Tell me", words: "" });
  await describe("when any task finishes, tell me");
  await cardOrSaid(page);
  const count = (await procedures()).length;
  await page.locator('[data-act="trig-no"]').click();
  check("trig-no", (await page.locator(".prop17d").count()) === 0 && (await procedures()).length === count, "the card goes; nothing saved");
}

async function skillScripted(page, api, stamp) {
  await openAddSkill(page);
  await typeInto(page, "#sk-what", "Every Friday, check the price list and tell me if paper went up.");
  await page.locator('.dlg [data-act="sk-draft"]').click();
  await page.locator(".dlg #sk-draft pre").waitFor();
  const shown = await page.locator(".dlg #sk-draft pre").innerText();
  check("sk-draft", shown.includes(`name: paper-watch-${stamp}`) && ((await api("state")).skills ?? []).length === 0 && !(await page.locator('.dlg [data-act="sk-save"]').isDisabled()),
    "the draft is shown; GET /api/state skills still empty; Add skill is enabled");
  await shot(page, "skill-draft");
  await page.locator('.dlg [data-act="sk-save"]').click();
  const skill = await until(async () => ((await api("state")).skills ?? []).find((s) => s.name === `paper-watch-${stamp}`));
  check("sk-save", !!skill, `GET /api/state skills: ${skill?.name}`);
}

async function recipeScripted(page, api, recipe) {
  await place(page, "automations");
  await tab(page, "automations", "procedures");
  await page.locator(`[data-act="flow"][data-id="${recipe.id}"]`).click();
  await page.locator('.dlg [data-act="flow-save"]').waitFor();
  await noSoon(page, ".dlg .flow-row", "a saved recipe's steps");
  await allSoon(page, '.dlg .acts > .btn:not([data-act])', "a saved recipe's Add a step and Run (no route writes a step or runs a recipe)", 2);
  await page.locator('.dlg [data-act="flow-mv"][data-j="2"][data-d="-1"]').click();
  await page.locator('.dlg [data-act="flow-rm"][data-j="0"]').click();
  await shot(page, "recipe-draft");
  await page.locator('.dlg [data-act="flow-save"]').click();
  await clearToast(page);
  await page.locator('.dlg [data-act="ppapprove17d"]').click();
  const recipeSaid = await toastText(page);
  const kept = await until(async () => { const r = (await api("state")).procedures.find((p) => p.id === recipe.id); return r?.data.version === 2 ? r : null; });
  const tools = kept?.data.definition.steps.map((s) => s.args.path).join(",");
  check("flow-mv / flow-rm / flow-save (a recipe)", tools === "note-3.txt,note-2.txt" && kept.data.status === "proposed" && kept.data.history.length === 1 && /verified again/.test(recipeSaid),
    `GET /api/state procedures: steps ${tools}, version 2, ${kept?.data.status}; the engine says "${recipeSaid}"`);
}

/* fix399: two steps that read the same (same tool and words, different expected results) swapped is a change: Save shows
   it and Approve saves it. */
async function recipeSameSteps(page, api, recipe) {
  await place(page, "automations");
  await tab(page, "automations", "procedures");
  await page.locator(`[data-act="flow"][data-id="${recipe.id}"]`).click();
  await page.locator('.dlg [data-act="flow-mv"][data-j="0"][data-d="1"]').click();
  await page.locator('.dlg [data-act="flow-save"]').click();
  const approve = page.locator('.dlg [data-act="ppapprove17d"]');
  const shown = await approve.waitFor({ timeout: 4000 }).then(() => true, () => false);
  check("flow-save (a recipe, two steps that read the same, swapped)", shown && !(await approve.isDisabled()), "the change is shown and Approve is enabled");
  if (!shown) return;
  await clearToast(page);
  await approve.click();
  const kept = await until(async () => { const r = (await api("state")).procedures.find((p) => p.id === recipe.id); return r?.data.version === 2 ? r : null; });
  check("ppapprove17d (the swap is saved)", kept?.data.definition.steps.map((s) => s.expected).join(",") === "second,first", `GET /api/state procedures: expected ${kept?.data.definition.steps.map((s) => s.expected)}`);
}

/* fix399: a recipe changed after the dialog opened is not rearranged by the old places; the engine says so. */
async function recipeStale(page, api, app, recipe, step) {
  await place(page, "automations");
  await tab(page, "automations", "procedures");
  await page.locator(`[data-act="flow"][data-id="${recipe.id}"]`).click();
  await page.locator('.dlg [data-act="flow-mv"][data-j="1"][data-d="-1"]').click();
  await page.locator('.dlg [data-act="flow-save"]').click();
  await page.locator('.dlg [data-act="ppapprove17d"]').waitFor();
  app.knowledge.proposeProcedure(app.runtime.context(), { id: recipe.id, name: recipe.data.definition.name, preconditions: [], steps: [step(7), step(8), step(9)] });
  await clearToast(page);
  await page.locator('.dlg [data-act="ppapprove17d"]').click();
  const said = await toastText(page);
  const now = (await api("state")).procedures.find((p) => p.id === recipe.id)?.data;
  check("ppapprove17d (a recipe changed since it was opened)", /changed since you opened it/.test(said) && now?.version === 2 && now.definition.steps.map((s) => s.args.path).join(",") === "note-7.txt,note-8.txt,note-9.txt",
    `the engine says "${said}"; GET /api/state: version ${now?.version}, steps as the other change left them`);
  await page.locator('.dlg [data-act="ppback17d"]').click().catch(() => {});
  await page.locator('.dlg [data-act="dlg-close"]').first().click().catch(() => {});
}

async function agentRemove(page, api, agentName, agentId) {
  await place(page, "customize");
  await tab(page, "customize", "tools");
  await page.locator('[data-act="t9-kind"][data-v="agents"]').click();
  await page.locator(`[data-act="t9-sel"][data-v="${agentId}"]`).click(); // an agent is listed by its id
  const rm = page.locator('.t9-detail [data-act="tool-rm"]');
  check("another agent's Remove is live", !(await rm.getAttribute("class")).includes("soon") && (await rm.getAttribute("aria-disabled")) !== "true", "its Remove is not greyed (Check for updates is not this branch's)");
  await page.locator('.t9-detail [data-act="tool-rm"]').click();
  await page.locator('.dlg [data-act="tool-rm"][data-sure="1"]').waitFor();
  check("tool-rm asks first", ((await api("agents/remote")).agents ?? []).some((a) => a.name === agentName), "a confirm is shown; GET /api/agents/remote still lists it");
  await shot(page, "agent-remove");
  await page.locator('.dlg [data-act="tool-rm"][data-sure="1"]').click();
  const gone = await until(async () => !((await api("agents/remote")).agents ?? []).some((a) => a.name === agentName));
  check("tool-rm (another agent)", gone, "GET /api/agents/remote no longer lists it");
}

/* A plugin installed as an add-on package (the bundled one, through the engine's own install route) is removed after a
   confirm; the engine's add-on shelf takes out only the files it installed. */
async function pluginRemove(page, api) {
  await api("plugin-catalog/add-ons/settings", { modes: { packages: "on" } });
  const bundled = (await api("plugin-catalog/add-ons")).bundled.map((b) => b.offer).find((o) => o.plugin);
  await api("plugin-catalog/add-ons/bundled/install", { id: bundled.id, sha256: bundled.sha256 });
  const listed = await until(async () => (await api("plugins")).plugins.find((p) => (p.id ?? p.name) === bundled.id));
  await place(page, "customize");
  await tab(page, "customize", "tools");
  await page.locator('[data-act="t9-kind"][data-v="plugins"]').click();
  await page.locator(`[data-act="t9-sel"][data-v="${bundled.id}"]`).click();
  await page.locator('.t9-detail [data-act="tool-rm"]').click();
  await page.locator('.dlg [data-act="tool-rm"][data-sure="1"]').waitFor();
  check("tool-rm (a plugin) asks first", !!listed && !!(await api("plugins")).plugins.find((p) => (p.id ?? p.name) === bundled.id), "a confirm is shown; GET /api/plugins still lists it");
  await page.locator('.dlg [data-act="tool-rm"][data-sure="1"]').click();
  const gone = await until(async () => !(await api("plugins")).plugins.some((p) => (p.id ?? p.name) === bundled.id) && !(await api("plugin-catalog/add-ons")).installed.some((r) => r.id === bundled.id));
  check("tool-rm (a plugin installed as an add-on)", gone, "GET /api/plugins and GET /api/plugin-catalog/add-ons no longer list it");
}

async function scriptedEngine(browser, stamp, errors) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-finish-soon-a-"));
  const model = scripted(stamp);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const { api } = client(server.url, server.token);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push(`scripted: ${e.message}`));
  try {
    await api("autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
    // Test fixtures on the scripted engine only: a saved recipe (recipes are made by a task's tools) and another agent
    // (adding one reads its card over the network, which the address rules refuse for a local test).
    const step = (n) => ({ tool: "files.read", args: { path: `note-${n}.txt` }, expected: `text ${n}` });
    const recipe = app.knowledge.proposeProcedure(app.runtime.context(), { name: `Read notes ${stamp}`, preconditions: [], steps: [step(1), step(2), step(3)] });
    // fix399: two steps that read the same, and a recipe another task changes while its dialog is open; and a Trunk, so
    // the trigger card has a Who does it to draw.
    const same = (expected) => ({ tool: "files.read", args: { path: "same.txt" }, expected });
    const sameRecipe = app.knowledge.proposeProcedure(app.runtime.context(), { name: `Read same ${stamp}`, preconditions: [], steps: [same("first"), same("second")] });
    const staleRecipe = app.knowledge.proposeProcedure(app.runtime.context(), { name: `Read stale ${stamp}`, preconditions: [], steps: [step(4), step(5), step(6)] });
    await api("trunks/switch", { part: "trunks", mode: "on" });
    await api("trunks", { name: `Reader ${stamp}` });
    const agentName = `Helper ${stamp}`, agentId = randomUUID();
    app.store.save("settings", app.runtime.owner, `remote-agent:${agentId}`, { id: agentId, name: agentName, description: "", cardUrl: "https://agent.invalid/.well-known/agent.json", url: "https://agent.invalid/a2a", skills: [], addedAt: new Date().toISOString() });
    await signIn(page, server.url, server.token, api);
    await triggersScripted(page, api, model);
    await skillScripted(page, api, stamp);
    await recipeScripted(page, api, recipe);
    await recipeSameSteps(page, api, sameRecipe);
    await recipeStale(page, api, app, staleRecipe, step);
    await agentRemove(page, api, agentName, agentId);
    await pluginRemove(page, api);
  } finally {
    await page.close();
    await server.close().catch(() => {});
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const stamp = Date.now().toString(36);
  const { api, call } = client(`http://127.0.0.1:${PORT}`, TOKEN);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const part of ["trunks", "routines"]) await api("trunks/switch", { part, mode: "on" });
    await api("autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
    const trunk = (await api("trunks", { name: `Reader ${stamp}` })).trunk;
    const proc = (await api("autonomy/procedures", { name: `Tidy ${stamp}`, start: { kind: "manual" }, steps: [{ title: "Tidy", prompt: "tidy the notes folder" }] })).procedure;
    await signIn(page, `http://127.0.0.1:${PORT}`, TOKEN, api);
    await notDrawn(page);
    await flowRun(page, api, proc);
    await whoDoesIt(page, api, trunk);
    await whoFive(page, api, stamp);
    await triggerNoModel(page, api);
    await skillNoModel(page, api);
    await ifOwner(page, api, trunk, stamp);
    await nameDevice(page, api, call, stamp);
    await launchRemoveGreyed(page);
    await scriptedEngine(browser, stamp, errors);
  } catch (error) {
    check("the run finished", false, error.stack || error.message);
    await shot(page, "failure").catch(() => {});
  } finally {
    check("no page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
