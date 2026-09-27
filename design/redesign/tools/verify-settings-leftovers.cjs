/* Clicks every control the settings-leftovers area (round 3) made live against a running engine and confirms each result
   through the engine's own GET route. Run it only against a throwaway engine, because it turns on the local-models switch
   and records evaluation runs:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-settings-leftovers.cjs
   It starts no stand-in servers. The one-click install is checked on a machine with no model runtime: the engine refuses,
   the window shows that refusal word for word, and no setup job is recorded. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const skipped = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}

const live = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 10000 });
  if ((await el.getAttribute("aria-disabled")) === "true") throw new Error(`${sel} is greyed`);
  return el;
};
const click = async (page, sel) => (await live(page, sel)).click();
const settle = (page, ms = 600) => page.waitForTimeout(ms);
async function lastToast(page, text) {
  try { await page.locator(".toast", { hasText: text }).first().waitFor({ timeout: 8000 }); return true; } catch { return false; }
}
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await click(page, `[data-act="setpage"][data-v="${id}"]`);
  await settle(page, 1000);
}

/* Data & usage › Test the model you use: pick the second suite, run it, and see one more run recorded for that suite. */
async function evaluation(page) {
  const { suites } = await api("evaluation/suites");
  await openPage(page, "usage");
  const labels = await page.locator('[data-act="eval-set"]').allTextContents();
  check("test sets are the engine's suites", labels.length === suites.length && suites.every((s, i) => labels[i] === `${s.name} · ${s.tasks.length}`), labels.join(" | "));
  const suite = suites[1] ?? suites[0];
  await click(page, `[data-act="eval-set"][data-v="${suite.id}"]`);
  await settle(page);
  check("eval-set picks the suite", (await page.locator(`[data-act="eval-set"][data-v="${suite.id}"]`).getAttribute("aria-pressed")) === "true");
  const before = (await api(`evaluation/history?suite=${suite.id}`)).runs.length;
  await click(page, '[data-act="eval-run"]');
  await page.locator('[data-act="eval-run"]:not([disabled])').waitFor({ timeout: 300000 });
  await settle(page);
  const { runs } = await api(`evaluation/history?suite=${suite.id}`);
  check("eval-run records a run of the chosen suite", runs.length === before + 1 && runs[0].suiteId === suite.id, `${before} -> ${runs.length}`);
  const shown = (await page.locator(".set-col .status b").last().textContent()) ?? "";
  const want = `${runs[0].summary.passed} of ${runs[0].summary.total} right`;
  check("the result shown is the engine's record", shown.startsWith(want), shown);
  const note = runs[0].regressionNote;
  if (note) check("the engine's regression note is shown verbatim", ((await page.locator(".set-col .status p").last().textContent()) ?? "").includes(note), note);
}

/* On this computer › Install: the engine's refusal, word for word, with the switch off and then with no runtime. */
async function install(page) {
  const setupsBefore = (await api("local-models")).oneClick?.setups?.length ?? 0;
  await api("local-models/switch", { mode: "off" });
  await openPage(page, "local");
  await page.locator('[data-act="lm-get"]').first().waitFor({ timeout: 15000 });
  let ok = false;
  try { await api("local-models/setup", { model: "x-probe", quant: "Q4_K_M" }); } catch (e) { ok = e.message; }
  const offNote = String(ok).replace(/^local-models\/setup: /, "");
  await click(page, '[data-act="lm-get"]:not([disabled])');
  check("lm-get shows the engine's switched-off refusal", await lastToast(page, offNote), offNote);

  /* The refusal is asked for directly only where it cannot start anything: no runtime program on this computer. */
  const runtimes = (await api("local-models")).oneClick?.runtimes ?? [];
  if (runtimes.some((r) => r.installed)) { skipped.push("the no-runtime refusal (a model runtime is installed here)"); console.log("SKIP  the no-runtime refusal: a model runtime is installed here"); return; }
  await api("local-models/switch", { mode: "on" });
  await openPage(page, "general");
  await openPage(page, "local");
  const btn = page.locator('[data-act="lm-get"]:not([disabled])').first();
  const probe = await api("local-models/setup", { model: await btn.getAttribute("data-id"), quant: await btn.getAttribute("data-v") }).catch((e) => ({ error: e.message }));
  const words = probe.needsRuntime ? probe.message : null;
  if (words) {
    await click(page, '[data-act="lm-get"]:not([disabled])');
    check("lm-get shows the engine's no-runtime refusal", await lastToast(page, words), words);
  } else check("this machine has no model runtime (needed for the refusal check)", false, JSON.stringify(probe).slice(0, 200));
  const setupsAfter = (await api("local-models")).oneClick?.setups?.length ?? 0;
  check("no setup job was recorded by a refused install", setupsAfter === setupsBefore, `${setupsBefore} -> ${setupsAfter}`);
  await api("local-models/switch", { mode: "off" });
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    await evaluation(page);
    await install(page);
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed${skipped.length ? `, ${skipped.length} skipped: ${skipped.join("; ")}` : ""}`);
  process.exit(bad ? 1 : 0);
})();
