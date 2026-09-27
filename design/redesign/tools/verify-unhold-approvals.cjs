/* unhold-approvals: clicks every approvals-and-secrets control made live and reads each change back through the engine.
   It starts its own fresh engine in this process (a scripted model that writes the file it is asked to, "Ask before
   changes", new conversations following the owner's rules), so real questions wait for an answer; nothing reaches a
   provider and nothing outside a temporary folder is touched. Build first (npx tsc -p .), then:
     node design/redesign/tools/verify-unhold-approvals.cjs
   Controls: Always allow on the approval card, Allow all in the Inbox, the rule list with Add a rule and Remove, the
   second look switch (with the engine's loosening confirm and Lockdown's refusal), a "without asking" switch (Q257: its
   loosening confirm, Cancel, and Lockdown), and the password manager (Q257: the chosen one first, the other kept). It also
   checks what stays greyed: Move up, Hold back keys, and Windows Credential Manager. */
const { pathToFileURL } = require("node:url");
const { resolve, join } = require("node:path");
const { mkdtempSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");

const load = (name) => {
  try { return require(name); } catch { return require(`C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/${name}`); }
};
const { chromium } = load("playwright");
const dist = (file) => import(pathToFileURL(resolve(__dirname, "../../../dist", file)).href);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
let BASE = "", TOKEN = "";
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const until = async (what, probe, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const got = await probe(); if (got) return got; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 250)); }
};
const dlg = (page) => page.locator(".scrim .dlg");
const greyed = async (loc) => (await loc.count()) > 0 && ((await loc.first().getAttribute("aria-disabled")) === "true" || await loc.first().isDisabled());
const toastText = (page) => page.locator(".toast").first().innerText().catch(() => "");
async function openSettings(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="general"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}
const closeSettings = async (page) => { if (await page.locator(".settings").count()) { await page.keyboard.press("Escape"); await settle(page, 300); } };

/* Always allow: a real question from the window's own conversation; the yes is kept as the owner's rule. */
async function alwaysAllow(page, ctx) {
  await page.locator("#prompt").fill("write always.txt");
  await page.locator("#send").click();
  const card = page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 30000 });
  await card.getByRole("button", { name: "Always allow", exact: true }).click();
  const rule = await until("the standing rule", async () => (await api("rules")).rules.find((r) => r.rule.tool === "files.write" && r.rule.decision === "allow"));
  check("Always allow: the engine keeps a standing rule (GET /api/rules)", rule, rule?.sentence);
  await until("the file", async () => existsSync(join(ctx.workspace, "always.txt")));
  check("Always allow: the task carried on and wrote the file", existsSync(join(ctx.workspace, "always.txt")));
  // Under Lockdown the engine keeps no standing yes, so the card does not offer one.
  await api("lockdown", { on: true });
  await page.reload();
  await page.locator("#app.locked").waitFor({ timeout: 30000 });
  await page.locator("#prompt").fill("write locked.txt");
  await page.locator("#send").click();
  const locked = page.locator("#live-ask");
  await locked.waitFor({ state: "visible", timeout: 30000 });
  check("Always allow under Lockdown: not offered", (await locked.getByRole("button", { name: "Always allow", exact: true }).count()) === 0);
  await locked.getByRole("button", { name: "Don’t allow", exact: true }).click();
  await until("the refusal", async () => !(await api("policy")).waiting.some((q) => q.target === "locked.txt"));
  await api("lockdown", { on: false });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 30000 });
  await settle(page, 1000);
}

/* Allow all: two tasks waiting on a yes; the confirm names both, and both are answered once. */
async function allowAll(page, ctx) {
  await ctx.app.runtime.run({ prompt: "write first.txt" });
  await ctx.app.runtime.run({ prompt: "write second.txt" });
  const waiting = (await api("policy")).waiting.filter((q) => !q.parentRunId);
  await page.locator('[data-act="view"][data-v="inbox"]').first().click();
  await page.locator('[data-act="ptab"][data-place="inbox"][data-v="needs"]').first().click();
  const button = page.locator('#main [data-act="allowall"]');
  await button.waitFor({ timeout: 10000 });
  check("Allow all: live, with the engine's count", !(await greyed(button)) && (await button.innerText()).includes(String(waiting.length)), `${waiting.length} waiting`);
  await button.click();
  const listed = await dlg(page).locator("li").allTextContents();
  check("Allow all: the confirm names each waiting request", listed.length === waiting.length && waiting.every((q) => listed.includes(q.question || q.label)), listed.join(" | "));
  await dlg(page).locator('[data-act="allowall-go"]').click();
  const left = await until("the answers", async () => { const w = (await api("policy")).waiting; return w.length === 0 ? [] : null; }).catch(() => null);
  check("Allow all: nothing is waiting afterwards (GET /api/policy)", left !== null);
  await until("both files", async () => existsSync(join(ctx.workspace, "first.txt")) && existsSync(join(ctx.workspace, "second.txt"))).catch(() => null);
  check("Allow all: both tasks went ahead", existsSync(join(ctx.workspace, "first.txt")) && existsSync(join(ctx.workspace, "second.txt")));
  const kept = (await api("rules")).rules.filter((r) => r.rule.decision === "allow" && /first|second/.test(r.rule.match));
  check("Allow all: no standing rule was kept for them", kept.length === 0);
}

/* The rule list: the engine's sentences, Add a rule (proved with the rule tester), Remove, and Lockdown's refusal. */
async function ruleList(page) {
  await openSettings(page, "permissions");
  const engine = (await api("rules")).rules;
  const shown = await page.locator(".rule15 b").allTextContents();
  check("rules: one row per engine rule, in the engine's words", JSON.stringify(shown) === JSON.stringify(engine.map((r) => r.sentence)), `${shown.length} of ${engine.length}`);
  check("rules: Move up stays greyed (no route moves one rule)", engine.length === 0 || await greyed(page.locator('[data-act="rule-up8"]')));
  await page.locator('[data-act="rule-add8"]').click();
  await page.locator("#rule-new8").fill("https://blocked.example");
  await dlg(page).locator('[data-act="rule-dec8"][data-v="deny"]').click();
  await dlg(page).locator('[data-act="rule-save8"]').click();
  await settle(page, 1200);
  const first = (await api("rules")).rules[0];
  check("Add a rule: the engine keeps it in front (GET /api/rules)", first?.rule.decision === "deny" && first?.rule.resource?.pattern === "blocked.example", first?.sentence);
  const tested = await api("rules/test", { tool: "web.fetch", target: "blocked.example" });
  check("Add a rule: the engine now refuses that site (POST /api/rules/test)", tested.decision === "deny", tested.because);
  check("Add a rule: the new row is drawn first", (await page.locator(".rule15 b").first().textContent()) === first.sentence);
  const before = (await api("rules")).rules.length;
  await page.locator('[data-act="rule-rm8"][data-i="0"]').click();
  const after = await until("the removal", async () => { const r = (await api("rules")).rules; return r.length === before - 1 ? r : null; }).catch(() => null);
  check("Remove: the engine drops that rule (GET /api/rules)", after && !after.some((r) => r.rule.resource?.pattern === "blocked.example"));
  await api("lockdown", { on: true });
  const locked = (await api("rules")).rules;
  await openSettings(page, "permissions");
  await page.locator('[data-act="rule-add8"]').click();
  await page.locator("#rule-new8").fill("https://open.example");
  await dlg(page).locator('[data-act="rule-dec8"][data-v="allow"]').click();
  await dlg(page).locator('[data-act="rule-save8"]').click();
  await settle(page, 1000);
  check("Add a rule under Lockdown: the engine refuses, in its own words", /Lockdown is on/.test(await toastText(page)), await toastText(page));
  check("Add a rule under Lockdown: nothing changed", JSON.stringify((await api("rules")).rules) === JSON.stringify(locked));
  if (await dlg(page).count()) await page.locator('.scrim [data-act="dlg-close"]').first().click();
  await api("lockdown", { on: false });
}

/* A second look before approvals: on tightens; off asks first with the engine's words; Lockdown refuses. */
async function secondLook(page) {
  const mode = async () => (await api("settings-kit")).settings.find((s) => s.key === "approval_reviewer").fields.find((f) => f.field === "mode").value;
  const box = () => page.locator("#f15-a-second-look-before-approvals");
  await openSettings(page, "permissions");
  check("second look: live, drawn from the engine", !(await greyed(box())) && (await box().isChecked()) === (await mode() !== "off"));
  await box().check();
  await until("on", async () => (await mode()) === "on");
  check("second look on: the engine keeps it (GET /api/settings-kit)", (await mode()) === "on");
  await box().uncheck();
  await dlg(page).waitFor({ timeout: 8000 });
  check("second look off: the engine's loosening words are shown before anything changes", /less careful/.test(await dlg(page).innerText()) && (await mode()) === "on");
  await dlg(page).locator('[data-act="revkeepb17"]').click();
  await settle(page, 800);
  check("second look off, cancelled: still on, and the switch shows it", (await mode()) === "on" && await box().isChecked());
  await box().uncheck();
  await dlg(page).waitFor({ timeout: 8000 });
  await dlg(page).locator('[data-act="revoffb17"]').click();
  await until("off", async () => (await mode()) === "off");
  check("second look off, confirmed: the engine turns it off", (await mode()) === "off");
  await api("lockdown", { on: true });
  await openSettings(page, "permissions");
  await box().check();
  await settle(page, 1200);
  check("second look under Lockdown: refused in the engine's words, and still off", /Lockdown is on/.test(await toastText(page)) && (await mode()) === "off", await toastText(page));
  check("second look under Lockdown: the switch is drawn from the engine again", !(await box().isChecked()));
  await api("lockdown", { on: false });
  check("Hold back keys found in answers stays greyed (the leak guard has no switch)", await greyed(page.locator("#f15-hold-back-keys-found-in-answers")));
}

/* Q257: a "without asking" switch that loosens is refused by the engine until the owner says yes in the dialog; Cancel
   changes nothing, the dialog's own button sends confirmLoosening, and Lockdown refuses it in its own words. */
async function kindSwitch(page) {
  const decision = async () => (await api("approvals/categories")).categories.find((c) => c.id === "message").decision;
  await api("approvals/categories", { message: "ask" });
  const box = () => page.locator("#p-send");
  await openSettings(page, "permissions");
  check("without-asking switch: drawn off while messages ask", !(await box().isChecked()));
  await box().check();
  await dlg(page).waitFor({ timeout: 8000 });
  check("without-asking switch on: the engine's loosening words are shown first", /less careful/.test(await dlg(page).innerText()) && (await decision()) === "ask");
  await dlg(page).locator('[data-act="dlg-close"]').first().click();
  await settle(page, 1000);
  check("without-asking switch, cancelled: still asks, and the switch shows it", (await decision()) === "ask" && !(await box().isChecked()));
  await box().check();
  await dlg(page).waitFor({ timeout: 8000 });
  await dlg(page).locator('[data-act="perm-loosen8"]').click();
  await until("allow", async () => (await decision()) === "allow");
  check("without-asking switch, confirmed: the engine lets messages through", (await decision()) === "allow");
  await api("lockdown", { on: true });
  await openSettings(page, "permissions");
  await box().uncheck().catch(() => undefined);
  await settle(page, 1200);
  await api("lockdown", { on: false });
  check("without-asking switch under Lockdown: nothing changed", (await decision()) === "allow");
}

/* The password manager: Bitwarden and 1Password through the engine; Windows greyed; the on/off switch untouched. */
async function passwordManager(page) {
  await openSettings(page, "secrets");
  check("password manager: Windows Credential Manager stays greyed (no engine service)", await greyed(page.locator('[data-act="vaultwinb17"]')));
  for (const [v, service] of [["bitwarden", "bitwarden"], ["onepassword", "1password"]]) {
    await page.locator(`[data-act="vaultb17"][data-v="${v}"]`).click();
    const saved = await until(service, async () => { const c = await api("credentials/settings"); return c.services[0] === service ? c : null; }).catch(() => null);
    check(`password manager ${service}: the engine keeps it (GET /api/credentials/settings)`, saved && saved.services[0] === service && saved.enabled === false, JSON.stringify(saved?.services)); // Q257: chosen first, the other kept
    await settle(page, 600);
    check(`password manager ${service}: drawn pressed from the engine`, (await page.locator(`[data-act="vaultb17"][data-v="${v}"]`).getAttribute("aria-pressed")) === "true");
  }
}

(async () => {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-unhold-approvals-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  const { createBranch } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const { readPolicy, savePolicy } = await dist("policy.js");
  const { saveConversationModeSettings } = await dist("conversation-mode.js");
  const writer = { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
    const asked = [...request.messages].reverse().find((m) => m.role === "user" && /^write \S+/.test(String(m.content)));
    if (last?.role === "user" && asked)
      return { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write", arguments: JSON.stringify({ path: String(asked.content).slice(6).trim(), content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace, dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { ...readPolicy(app.store, app.runtime.owner), rules: [{ tool: "files.write", decision: "ask" }] });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const server = await startServer(app, { dataDir, port: Number(process.env.PORT ?? 0) });
  BASE = server.url.replace(/\/$/, ""); TOKEN = server.token;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await settle(page, 1200);
    const ctx = { app, workspace };
    for (const step of [alwaysAllow, allowAll, ruleList, secondLook, kindSwitch, passwordManager]) {
      try { await step(page, ctx); } catch (e) { check(`${step.name} finished`, false, e.message); }
      await closeSettings(page).catch(() => {});
    }
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  await server.close();
  await app.close();
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.log(`left ${root}: ${e.message}`); }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
