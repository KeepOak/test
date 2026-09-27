/* Clicks every control the settings-b area (Permissions, Computer & browser, Saved sign-ins, Data & usage, Gateway,
   Branch itself, Updates & about, Achievements, Advanced, Developer) made live, against a running engine, and confirms
   each change through the engine's own GET route. Each switch is flipped and then flipped back, so the engine ends as
   it began. Run it only against a throwaway engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-settings-b.cjs
   It starts no stand-in servers. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
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

const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}

const onMode = (m) => Boolean(m) && m !== "off";
const f15 = (t) => "f15-" + t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
const coding = (part) => async () => onMode((await api("coding")).modes[part]);
const interop = (part) => async () => onMode((await api("interop")).parts.find((p) => p.part === part)?.mode);

/* [page, switch id, what the engine says now] */
const SWITCHES = [
  ["achievements", "ach-q", async () => (await api("delight")).settings.achievements.quiet === true],
  ["computer", f15("Page notes and “Send to Branch”"), async () => onMode((await api("browser/notes/settings")).settings.mode)],
  ["computer", f15("Try ideas on a branch"), coding("worktrees")],
  ["computer", f15("Check and format files after editing"), coding("format-on-edit")],
  ["computer", f15("Draft a pull request from a task"), async () => onMode((await api("developer/pull-requests")).mode)],
  ["computer", f15("Remember the shell"), coding("shell-snapshot")],
  ["computer", f15("Read a file before editing it"), coding("read-first")],
  ["computer", f15("Keep large tool outputs"), coding("large-output")],
  ["computer", f15("Read Jupyter notebooks"), coding("notebooks")],
  ["computer", f15("Review checks and a checklist per task"), async () => { const m = (await api("coding")).modes; return onMode(m["review-checks"]) && onMode(m.checklist); }],
  ["developer", "dv-ls", async () => (await api("developer/language-servers")).enabled === true],
  ["developer", "dv-dbg", async () => (await api("developer/debug-adapters")).enabled === true],
  ["developer", f15("Flow search"), interop("flow-search")],
  ["developer", f15("Send metrics with OpenTelemetry"), async () => onMode((await api("usage/counters")).counters.mode)],
  ["developer", f15("Is Branch keeping up"), async () => onMode((await api("event-loop")).settings.mode)],
  ["gateway", f15("Pause a chat app from the chat"), async () => onMode((await api("reach")).modes["platform-pause"])],
  ["gateway", f15("Send files into chats"), async () => onMode((await api("personal")).modes["chat-files"])],
  ["usage", "u-ring", async () => (await api("usage/glance/settings")).settings.ring === "shown"],
  ["usage", "u-ckpt", async () => (await api("usage/glance/settings")).settings.saveProgress === "ask"],
  ["usage", "u-ask", async () => onMode((await api("usage/limits/settings")).usageLimits.mode)],
  ["advanced", "ad-think", async () => (await api("knobs")).values.reasoning.showReasoning === true],
  ["advanced", "ad-log", async () => onMode((await api("diagnostics/log/settings")).mode)],
];

/* Branch itself › Updating itself: each choice is the engine's update setting. */
async function updatingItself(page) {
  await openPage(page, "self");
  const was = (await api("comfort")).values.notify.autoUpdate;
  for (const v of ["install", "check", "off", was]) {
    await page.locator(`[data-act="self-upd"][data-v="${v}"]`).click();
    await settle(page, 1200);
    const now = (await api("comfort")).values.notify.autoUpdate;
    check(`self-upd ${v}: the engine's update setting`, now === v, now);
    check(`self-upd ${v}: pressed as the engine says`, (await page.locator(`[data-act="self-upd"][data-v="${v}"]`).getAttribute("aria-pressed")) === "true");
  }
}

/* Branch itself › Every change › Roll back: a change made through the engine is listed and undone. */
async function rollBack(page) {
  await api("event-loop", { mode: "when-needed" });
  await openPage(page, "general");
  await openPage(page, "self");
  const newest = (await api("settings-kit/history")).records[0];
  const button = page.locator(`[data-act="self-rollback"][data-id="${newest.id}"]`);
  check("self-rollback: the newest change is listed with Roll back", (await button.count()) === 1, newest.detail);
  await button.click();
  await settle(page, 1500);
  const after = (await api("settings-kit/history")).records.find((r) => r.id === newest.id);
  check("self-rollback: the engine undid that change", Boolean(after?.undoneBy), after?.undoneBy ?? "not undone");
  check("self-rollback: the setting is back as it was", !onMode((await api("event-loop")).settings.mode));
}

/* Roll back never loosens: undoing a change that made Branch more careful is refused by the engine (the window never
   sends confirmLoosening), the refusal is shown word for word, and nothing changes. Put back through the API after. */
async function rollBackRefused(page) {
  await api("settings-kit/apply", { plan: { source: "set", key: "loop_guard", field: "mode", value: "on" }, accept: ["loop_guard.mode"] });
  const newest = (await api("settings-kit/history")).records[0];
  await openPage(page, "general");
  await openPage(page, "self");
  await page.locator(`[data-act="self-rollback"][data-id="${newest.id}"]`).click();
  await settle(page, 1200);
  const words = (await page.locator(".toast").last().textContent().catch(() => "")) ?? "";
  const after = (await api("settings-kit/history")).records.find((r) => r.id === newest.id);
  const guard = (await api("settings-kit")).settings.find((s) => s.key === "loop_guard").fields.find((f) => f.field === "mode").value;
  check("self-rollback refuses a loosening undo: the engine's words are shown", /less careful/.test(words), words);
  check("self-rollback refuses a loosening undo: the change is not undone", !after?.undoneBy && guard === "on", `undoneBy ${after?.undoneBy ?? "none"}, mode ${guard}`);
  await api("settings-kit/undo", { record: newest.id, confirmLoosening: true });
}

/* Permissions › Lockdown: the page's button follows the engine, and re-reads it when the page opens again after
   Lockdown changed elsewhere (here: through the API, as the banner's "Turn it off" would). */
async function lockdownFollows(page) {
  await openPage(page, "permissions");
  const btn = page.locator('[data-act="perm-lock"]');
  check("perm-lock starts as the engine says", (await btn.textContent()) === ((await api("lockdown")).on ? "Turn Lockdown off" : "Turn Lockdown on"));
  await btn.click();
  await settle(page, 1500);
  check("perm-lock: Lockdown is on in the engine", (await api("lockdown")).on === true);
  check("perm-lock: the button now offers to turn it off", (await btn.textContent()) === "Turn Lockdown off");
  await api("lockdown", { on: false });
  await openPage(page, "general");
  await openPage(page, "permissions");
  check("permissions re-reads Lockdown when opened again", (await page.locator('[data-act="perm-lock"]').textContent()) === "Turn Lockdown on");
}

/* Saved sign-ins › Remove: a sign-in written through the engine is listed, and Remove takes it off the engine's list. */
async function removeSignIn(page) {
  await api("vault-autofill/settings", { logins: [{ name: "verify-one", site: "one.example", item: "verify one" }, { name: "verify-two", site: "two.example", item: "verify two" }] });
  await openPage(page, "general");
  await openPage(page, "secrets");
  const names = await page.locator('.set-col [data-act="secret-rm"]').evaluateAll((els) => els.map((e) => e.dataset.name));
  check("secrets: the engine's sign-ins are listed", names.join("|") === "verify-one|verify-two", names.join("|"));
  await page.locator('[data-act="secret-rm"][data-name="verify-one"]').click();
  await settle(page, 1200);
  const left = (await api("vault-autofill/settings")).logins.map((l) => l.name);
  check("secret-rm: the engine no longer lists it, and keeps the other", left.join("|") === "verify-two", left.join("|"));
  await api("vault-autofill/settings", { logins: [] });
}

async function flip(page, pageId, id, engine) {
  const box = page.locator(`#${id}`);
  await box.waitFor({ state: "attached", timeout: 10000 });
  if ((await box.getAttribute("aria-disabled")) === "true" || (await box.isDisabled())) { check(`${pageId} › ${id} is live`, false, "greyed"); return; }
  const before = await engine();
  // A page draws its switches once its data is read; wait (up to 8 s) for the switch to show the engine's value instead of
  // judging it at a fixed moment, so a slower read on a busy machine doesn't fail a switch that works.
  const shown = await page.waitForFunction(([sel, want]) => document.querySelector(sel)?.checked === want, [`#${id}`, before], { timeout: 8000 }).then(() => true, () => false);
  check(`${pageId} › ${id} shows the engine's value`, shown, String(before));
  for (const want of [!before, before]) {
    await page.locator(`#${id}`).click();
    await settle(page, 1200);
    const now = await engine();
    check(`${pageId} › ${id} → ${want ? "on" : "off"} in the engine`, now === want, String(now));
    check(`${pageId} › ${id} redraws as the engine says`, (await page.locator(`#${id}`).isChecked()) === now);
  }
}

async function copyAddress(page) {
  await openPage(page, "developer");
  await page.locator('[data-act="dv-copy"]').click();
  await settle(page);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("dv-copy copies the address this window talks to", copied === `127.0.0.1:${PORT}`, copied);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true }); // setup through the API: a fresh engine opens on its first-run screens
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    let current = null;
    for (const [pageId, id, engine] of SWITCHES) {
      if (pageId !== current) { await openPage(page, pageId); current = pageId; }
      await flip(page, pageId, id, engine);
    }
    await copyAddress(page);
    await updatingItself(page);
    await rollBack(page);
    await rollBackRefused(page);
    await removeSignIn(page);
    await lockdownFollows(page);
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
