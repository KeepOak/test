/* Pass 18a, the helpers frame and the view-only helper conversation, against a running engine seeded with three helpers
   (design/redesign/tools/seed-helpers.mjs) and the stand-in model (stub-model-helpers.cjs) on the port of a local
   service's preset (PRESET: lm-studio on 1234, the default, or jan on 1337, ...), connected here if it is not yet:
     PORT=<port> TOKEN=<hex> [PRESET=jan] node design/redesign/tools/verify-helpers-frame.cjs
   SHOTS=<folder> saves the frame closed and open, the view-only conversation, each at 1440 and 390, light and dark.
   Checks, each against the engine's own GET routes:
   - a message holding "HELPERS" starts three helpers (GET /api/runs/<id>/steps helpers[]); the frame shows above the
     composer with three rows, each with the helper's name, its newest step and Stop, and a clock that ticks;
   - no helper's conversation joins the sidebar;
   - opening the frame shows a card per helper; Steer on one sends the note to that helper only (its steps gain the
     note, its siblings' do not);
   - Stop on one stops that helper only (it reads cancelled, the others running);
   - Open shows the helper's own record view only: no message box, "View only" and "Back to <parent>"; Back returns;
   - stopping the rest hides the frame, and the thread's chip reads how each ended ("3 helpers · 3 stopped");
   - no page errors. */
const { chromium } = require("playwright"); // the worktree's own
const { join } = require("node:path");

const { PORT = "3805", TOKEN, PRESET = "lm-studio", SHOTS } = process.env;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const api = async (path, body) => {
  const res = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const got = await res.json();
  if (!res.ok) throw new Error(`${path}: ${got.error ?? res.status}`);
  return got;
};
const until = async (fn, tries = 120, gap = 250) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, gap)); } return null; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, width, height, scheme) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  return { page, errors };
}
/* Each shot at 1440 and 390, light and dark: the same conversation in four windows, signed in once. */
const VIEWS = [];
async function shotWindows(browser) {
  if (!SHOTS) return;
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const scheme of ["light", "dark"]) VIEWS.push({ w, scheme, ...(await open(browser, w, h, scheme)) });
}
async function shots(sessionId, name, prepare) {
  for (const v of VIEWS) {
    if (!(await v.page.locator("#conversation, .vo18").count()) || !(await v.page.locator(".hf18a, .vo18").count())) {
      await v.page.evaluate((id) => { location.hash = "open=" + id; }, sessionId);
      await v.page.locator(".hf18a").waitFor({ timeout: 15000 }).catch(() => {});
    }
    if (prepare) await prepare(v.page);
    await v.page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, v.scheme);
    await pause(500);
    await v.page.screenshot({ path: join(SHOTS, `${name}-${v.w}-${v.scheme}.png`) });
  }
}

(async () => {
  await api("onboarding", { done: true });
  await api("deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const models = await api("models").catch(() => null);
  if (!JSON.stringify(models ?? {}).includes("stub-model"))
    await api("connections/from-preset", { provider: PRESET, key: "x", model: "stub-model" });

  /* Chromium itself, not Playwright's headless shell: the shell's screenshots drop a playing <video>'s picture, so the
     characters' faces came out blank in the shots while they played in the window. */
  const browser = await chromium.launch({ channel: "chromium" });
  const { page, errors } = await open(browser, 1440, 900, "light");
  await shotWindows(browser);
  const earlier = new Set(((await api("state")).runs ?? []).map((r) => r.id));
  await page.locator("#prompt").fill("HELPERS: check the September invoices");
  await page.locator("#prompt").press("Enter");

  const asked = await until(async () => (await api("state")).runs?.find((r) => !earlier.has(r.id) && r.prompt.startsWith("HELPERS")), 120);
  check("the message started a task", !!asked);
  /* The task that hands the work out: the message's own, or the one that carries on after an Allow. */
  const newest = async () => ((await api("state")).runs ?? []).filter((r) => r.sessionId === asked.sessionId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  let parent = asked;
  const running = async () => (await api(`runs/${parent.id}/steps`)).helpers ?? [];
  // The owner's rules may ask before the task hands work out: allowed once, from the conversation's own card.
  const allow = page.locator('#live-ask [data-act="ask"][data-v="allow"]');
  const three = await until(async () => {
    if (await allow.count()) await allow.first().click().catch(() => {});
    parent = (await newest()) ?? parent;
    const list = await running();
    return list.length === 3 && list.every((h) => h.status === "running" && h.lastStep) ? list : null;
  }, 240);
  check("the engine has three running helpers, each with a newest step", !!three, JSON.stringify((await running()).map((h) => [h.name, h.status, h.lastStep?.title])));
  const helpers = three ?? (await running());

  await page.locator(".dock .hf18a").waitFor({ timeout: 20000 });
  await until(async () => (await page.locator(".hf18a .hfr18a [data-act='hfstop18a']").count()) === 3, 60);
  check("the frame sits at the top of the dock, above the message box", await page.evaluate(() => {
    const dock = document.querySelector(".dock"), frame = dock?.querySelector(".hf18a"), box = dock?.querySelector("#composer");
    return !!frame && !!box && dock.firstElementChild === frame && frame.getBoundingClientRect().bottom <= box.getBoundingClientRect().top;
  }));
  await until(async () => (await page.locator(".hf18a .hfr18a .live18").allInnerTexts()).every((line) => line.trim()), 40);
  const rows = await page.locator(".hf18a .hfr18a").allInnerTexts();
  check("three rows, each with its name, its newest step and Stop", rows.length === 3 && helpers.every((h) => rows.some((r) => r.includes(h.name) && r.includes(h.lastStep.title.split("\n")[0]) && /Stop/.test(r))), JSON.stringify(rows));
  check("the header counts the helpers", /3 helpers/.test(await page.locator(".hfh18a").innerText()));
  /* Never a blank face: each shows a painted picture of its loop or, not yet playing, its still. */
  await pause(1500);
  const blank = await page.evaluate(() => [...document.querySelectorAll(".hf18a .face18 video")].filter((v) => v.getClientRects().length)
    .filter((v) => !((v.readyState >= 2 && v.videoWidth > 0) || (!v.played.length && v.poster))).length);
  check("every helper's face shows its character, moving or still", blank === 0, `${blank} blank`);
  check("each face acts out its helper's own state, never the parent's needs-you", (await page.locator('.hf18a .face18 [data-st="wait"], .hf18a .face18 .waiting').count()) === 0
    && (await page.locator('.hf18a .face18 [data-st="work"]').count()) > 0);
  const t1 = await page.locator(".time18").innerText();
  await pause(2200);
  const t2 = await page.locator(".time18").innerText();
  check("the clock ticks from the first helper's start", /^\d+:\d\d$/.test(t2) && t1 !== t2, `${t1} -> ${t2}`);
  const inSide = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`#side [data-id="${id}"]`)).length, helpers.map((h) => h.sessionId));
  check("no helper's conversation joins the sidebar", inSide === 0);
  check("the thread's chip steps aside while the frame shows", (await page.locator("#conversation .hl17c").count()) === 0);

  const sessionId = parent.sessionId;
  await shots(sessionId, "frame-closed");

  // Open the roster; steer the first helper.
  await page.locator(".hfh18a").click();
  await page.locator(".hf18a.open .card18a").first().waitFor();
  check("opened, a card per helper", (await page.locator(".hf18a.open .card18a").count()) === 3);
  await shots(sessionId, "frame-open", async (p) => { if (!(await p.locator(".hf18a.open").count())) await p.locator(".hfh18a").click(); });
  const [first, second, third] = helpers;
  await page.locator(`.card18a [data-act="hfsteer18a"][data-id="${first.runId}"]`).click();
  await page.locator("#steer18").fill("only the August ones");
  await page.locator(`[data-act="hfsend18a"][data-id="${first.runId}"]`).click();
  const noted = async (h) => ((await api(`runs/${h.runId}/steps`)).steps ?? []).some((s) => s.kind === "you" && /only the August ones/.test(s.title));
  check("Steer reached that helper", !!(await until(() => noted(first), 40)));
  check("and not its siblings", !(await noted(second)) && !(await noted(third)));

  // Stop the second helper only.
  await page.locator(`.card18a [data-act="hfstop18a"][data-id="${second.runId}"]`).click();
  const stopped = await until(async () => { const list = await running(); return list.find((h) => h.runId === second.runId)?.status === "cancelled" ? list : null; }, 60);
  check("Stop stopped that helper", !!stopped);
  check("the others keep going", !!stopped && stopped.filter((h) => h.runId !== second.runId).every((h) => h.status === "running"), JSON.stringify(stopped?.map((h) => h.status)));

  // Open the third helper's conversation, view only.
  await page.locator(`.card18a [data-act="hfopen18a"][data-id="${third.runId}"]`).click();
  await page.locator(".vo18").waitFor({ timeout: 10000 });
  check("view only: no message box", (await page.locator("#composer, #prompt").count()) === 0);
  check("view only: one way back to the parent", /View only/.test(await page.locator(".vo18").innerText()) && (await page.locator('[data-act="voback18"]').count()) === 1 && /^Back to /.test(await page.locator('[data-act="voback18"]').innerText()));
  check("view only: the helper's header", /Helper for .+ · view only/.test(await page.locator(".head .vo18h").innerText()));
  await page.locator(".vosteps18 li").first().waitFor({ timeout: 8000 }).catch(() => {});
  check("view only: what the parent asked for, and its steps", (await page.locator(".voh18").innerText()).includes(third.job) && (await page.locator(".vosteps18 li").count()) >= 1,
    JSON.stringify([await page.locator(".voh18").innerText(), await page.locator(".vosteps18 li").allInnerTexts()]));
  const said = async () => (await api(`sessions/${sessionId}`)).messages.filter((m) => m.role === "user").length;
  const before = await said();
  await page.keyboard.press("Enter");
  await pause(600);
  check("nothing was sent from the view", (await said()) === before);
  await shots(sessionId, "view-only", async (p) => {
    if (!(await p.locator(".hf18a.open").count())) await p.locator(".hfh18a").click();
    await p.locator(`.card18a [data-act="hfopen18a"][data-id="${third.runId}"]`).click();
    await p.locator(".vo18").waitFor({ timeout: 10000 });
  });
  await page.locator('[data-act="voback18"]').click();
  await page.locator("#prompt").waitFor({ timeout: 10000 });
  check("Back returns to the conversation and its frame", (await page.locator(".dock .hf18a").count()) === 1);

  // Stop the rest from the collapsed rows: the frame goes, and the chip says done.
  if (await page.locator(".hf18a.open").count()) await page.locator(".hfh18a").click();
  for (const h of [first, third]) {
    const stop = page.locator(`.hfr18a [data-act="hfstop18a"][data-id="${h.runId}"]`);
    if (await stop.count()) await stop.click();
    await until(async () => (await running()).find((x) => x.runId === h.runId)?.status !== "running", 60);
  }
  const gone = await until(async () => (await page.locator(".hf18a").count()) === 0, 80);
  check("with none working, the frame goes", !!gone);
  const chip = await until(async () => { const el = page.locator("#conversation .hl17c"); return (await el.count()) ? el.innerText() : null; }, 80);
  check("and the thread's chip reads how each ended, stopped here", /3 helpers · 3 stopped/.test(chip ?? ""), chip ?? "");

  for (const v of VIEWS) errors.push(...v.errors);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
