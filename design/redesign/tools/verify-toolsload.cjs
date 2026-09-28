/* toolsload: Customize › Tools shows, for each server, plugin and skill, "Load tools only when needed" and what it
   costs a request, against a running engine:
     PORT=<port> TOKEN=<hex> ENGINE_PID=<pid of that engine> node design/redesign/tools/verify-toolsload.cjs
   Checks, each against the engine's own GET routes:
   - a skill installed now (POST /api/skills/install) is in GET /api/tools/context at once, on "when-needed", with a
     token cost; the window draws its switch on, with that cost;
   - switching it off saves "always" (GET /api/tools/context), and the cost shown is the engine's new one; on again
     saves "when-needed";
   - the engine's process is the same one throughout (ENGINE_PID still running, the same session answering): nothing
     was restarted; zero page errors. */
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { waitInPage } = require("./wait-in-page.cjs");

const { PORT = "3808", TOKEN, ENGINE_PID } = process.env;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const api = async (path, body) => {
  const res = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const got = await res.json();
  if (!res.ok) throw new Error(`${path}: ${got.error ?? res.status}`);
  return got;
};
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const sourceOf = async (source) => (await api("tools/context")).sources.find((s) => s.source === source);

(async () => {
  check("the engine is running", ENGINE_PID && alive(ENGINE_PID), `pid ${ENGINE_PID}`);
  await api("onboarding", { done: true });
  const name = `verify-skill-${Date.now().toString(36)}`;
  const skill = await api("skills/install", { document: `---\nname: ${name}\ndescription: Used by the tools check to see a skill arrive without a restart.\n---\n\n1. Nothing.\n` });
  const first = await sourceOf(`skill:${skill.id}`);
  check("installed now, listed at once, waiting until needed", first && first.mode === "when-needed" && first.tokens.now > 0, JSON.stringify(first?.tokens));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.locator('[data-act="view"][data-v="customize"]').first().click();
  await page.locator('[data-act="ptab"][data-v="tools"]').click();
  await page.locator('[data-act="t9-kind"][data-v="skills"]').click();
  await page.locator(`[data-act="t9-sel"][data-v="${skill.id}"]`).click();
  const sw = page.locator(`input[data-sw="ctx9"][data-source="skill:${skill.id}"]`);
  await sw.waitFor({ timeout: 20000 });
  const row = page.locator(".ctl", { has: sw });
  check("the switch reads Load tools only when needed, on", (await row.locator("b").innerText()) === "Load tools only when needed" && await sw.isChecked());
  check("with the engine's cost", (await row.locator("small").innerText()) === `${first.tokens.now} tokens`, await row.locator("small").innerText());

  await sw.click();
  await waitInPage(page, async ({ id, token }) => {
    const got = await (await fetch("/api/tools/context", { headers: { authorization: `Bearer ${token}` } })).json();
    return got.sources.find((s) => s.source === `skill:${id}`)?.mode === "always";
  }, { id: skill.id, token: TOKEN }, { timeout: 10000 });
  const always = await sourceOf(`skill:${skill.id}`);
  check("off saves Always in context", always.mode === "always");
  await page.waitForFunction(({ source, text }) => document.querySelector(`input[data-source="${source}"]`)?.closest(".ctl")?.querySelector("small")?.textContent === text,
    { source: `skill:${skill.id}`, text: `${always.tokens.now} tokens` }, { timeout: 10000 });
  check("and shows the engine's new cost", !(await sw.isChecked()), `${always.tokens.now} tokens`);

  await sw.click();
  await waitInPage(page, async ({ id, token }) => {
    const got = await (await fetch("/api/tools/context", { headers: { authorization: `Bearer ${token}` } })).json();
    return got.sources.find((s) => s.source === `skill:${id}`)?.mode === "when-needed";
  }, { id: skill.id, token: TOKEN }, { timeout: 10000 });
  check("on again saves load when needed", (await sourceOf(`skill:${skill.id}`)).mode === "when-needed");

  await api(`skills/${skill.id}/remove`, { expectedRevision: (await api(`skills/${skill.id}`)).revision });
  check("removed: gone from the list at once", !(await sourceOf(`skill:${skill.id}`)));
  check("the same engine process throughout", alive(ENGINE_PID), `pid ${ENGINE_PID}`);
  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
