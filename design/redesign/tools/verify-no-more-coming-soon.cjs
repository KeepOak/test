/* Clicks the controls Q002 made live and confirms each change through the engine's own GET route; then runs nothing
   else. Run against a throwaway engine only (it changes the engine's knobs and preferences):
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-no-more-coming-soon.cjs
   The dead-controls count is design/redesign/tools/audit-dead-controls.cjs. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
}
const settle = (page, ms = 800) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1300);
}
const notGreyed = async (page, sel) => (await page.locator(sel).first().getAttribute("aria-disabled")) !== "true";

async function models(page) {
  await openPage(page, "models");
  for (const [id, typed, card, field, want] of [["m-spend", "3", "limits", "spendCapDollars", 3], ["m-retries", "4", "limits", "apiRetries", 4],
    ["m-first", "90", "limits", "localFirstReplySeconds", 90], ["m-rounds", "20", "limits", "maxModelRounds", 20],
    ["m-tooltime", "45", "commands", "toolTimeoutSeconds", 45], ["m-toolkb", "8", "commands", "toolAnswerChars", 8000]]) {
    const box = page.locator(`#${id}`);
    await box.fill(typed);
    await box.dispatchEvent("change");
    await settle(page);
    const v = (await api("knobs")).values[card][field];
    check(`${id} saves ${card}.${field}`, v === want, `${field}=${v}`);
  }
  await page.locator("#m-spend").fill("");
  await page.locator("#m-spend").dispatchEvent("change");
  await settle(page);
  /* Taking the cap away makes Branch less careful: the engine refuses without the owner's tick, and says so. */
  const refused = (await page.locator(".toast").allTextContents()).join(" | ");
  check("m-spend emptied: the engine keeps the cap and its refusal is shown", (await api("knobs")).values.limits.spendCapDollars === 3 && /less careful/.test(refused), refused.slice(0, 80));
  await page.locator('[data-act="m-par"][data-v="3"]').click(); await settle(page);
  check("m-par: sub-tasks at once", (await api("knobs")).values.subtasks.parallelSubtasks === 3);
  await page.locator('[data-act="m-tier"][data-v="flex"]').click(); await settle(page);
  check("m-tier: service tier", (await api("knobs")).values.reasoning.serviceTier === "flex");
  await page.locator('[data-act="m-sub"][data-v="default"]').click(); await settle(page);
  check("m-sub: model for sub-tasks", (await api("knobs")).values.subtasks.subtaskModel === "default");
  await page.locator('[data-act="m-sub"][data-v=""]').click(); await settle(page);
  check("m-sub: Same model is null", (await api("knobs")).values.subtasks.subtaskModel === null);
}

async function local(page) {
  await openPage(page, "local");
  await page.locator('[data-act="lm-look"][data-id="ollama"]').click();
  await settle(page, 1500);
  const note = (await api("local-models")).oneClick.runtimes.find((r) => r.id === "ollama").installNote;
  const toasts = (await page.locator(".toast").allTextContents()).join(" | ");
  check("lm-look: asks again, then says how to get it in the engine's words", toasts.includes(note), toasts.slice(0, 120));
  await page.locator('[data-act="lm-add"][data-id="vllm"]').click();
  await settle(page, 1500);
  check("lm-add: the add dialog opens at vLLM's form", (await page.locator(".dlg").count()) > 0 && /vLLM/.test(await page.locator(".dlg").first().innerText()));
  await page.keyboard.press("Escape");
  await settle(page);
}

async function others(page) {
  await openPage(page, "appearance");
  const before = (await api("state")).preferences?.reduceMotion === true;
  await page.locator("#a-still").click(); await settle(page);
  check("a-still saves reduceMotion", (await api("state")).preferences?.reduceMotion === !before);
  await page.locator("#a-still").click(); await settle(page);
  await openPage(page, "advanced");
  await page.locator('[data-act="ad-orders"]').click(); await settle(page);
  const orders = (await api("autonomy/orders")).orders;
  check("ad-orders lists the engine's standing orders", (await page.locator(".dlg").count()) > 0 && (await page.locator(".dlg .prow").count()) === orders.length, `orders=${orders.length}`);
  await page.keyboard.press("Escape");
  await openPage(page, "gateway");
  check("gw-restart is live on Gateway before Branch itself was opened", await notGreyed(page, '[data-act="gw-restart"]'));
}

(async () => {
  await api("onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#main").waitFor();
  await settle(page, 1500);
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await models(page);
  await local(page);
  await others(page);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  if (results.some((ok) => !ok)) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
