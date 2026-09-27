/* Long work: a task that loses its connection shows it in its live steps and carries on; its time so far and Pause sit
   over the steps; Pause stops it after the step it is on (checked through GET /api/activity?waiting=1); the chat and the
   Inbox's "Running in the background" then offer Resume, which carries it on to the end with nothing done twice
   (checked through GET /api/runs/<id>). Then, on a second engine with nothing switched on by hand, a plan limit on the
   first Claude Code account moves the work to the account "Work" (added through POST /api/accounts/add, which refuses
   while several accounts per connection is off), and the chat says so in its live steps; once the task ends, one quiet
   line keeps it (GET /api/runs/<id>/steps switched) and the model chip names the account (GET /api/accounts/session). Starts its own engines in this
   process on PORT (default 3815) with stand-in models, then drives the window and saves frames.
   Run: npm run build, then PORT=3815 OUT=<folder> node design/redesign/tools/verify-long-work.cjs */
const { chromium } = require("playwright");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const PORT = Number(process.env.PORT || 3815);
const OUT = process.env.OUT || join(tmpdir(), "verify-long-work");
mkdirSync(OUT, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const dist = join(__dirname, "../../../dist");
const load = (file) => import("file:///" + join(dist, file).replace(/\\/g, "/"));

/* Drops the connection on its first call, then reads four notes, one slow step at a time, then answers. */
let calls = 0;
const model = { name: "scripted", async complete(request) {
  calls++;
  if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  const n = request.messages.filter((m) => m.role === "tool").length;
  await pause(1500);
  if (n < 4) return { content: "", toolCalls: [{ id: `r${n + 1}`, name: "files.read", arguments: JSON.stringify({ path: `note${n + 1}.md` }) }] };
  return { content: "All four notes are read.", toolCalls: [] };
} };

async function engine(root, options = {}) {
  const { createBranch } = await load("index.js");
  const { startServer } = await load("server.js");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: PORT });
  const api = async (path, body) => (await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  return { app, server, api };
}
async function signIn(page, server) {
  await page.goto(server.url + "/");
  await page.getByLabel("Session token").fill(server.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("#prompt").waitFor();
}

async function dropPauseResume(browser) {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-long-work-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  for (let n = 1; n <= 4; n++) writeFileSync(join(workspace, `note${n}.md`), `note ${n}\n`);
  const { app, server, api } = await engine(root, { provider: model });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await signIn(page, server);
    await page.fill("#prompt", "read my four notes");
    await page.locator("#send").click();
    await page.locator("#live-steps .lw-head [data-act=lw-pause]").waitFor({ timeout: 20000 });
    const drop = page.locator("#live-steps li", { hasText: "Lost the connection to the model service" });
    await drop.waitFor({ timeout: 20000 });
    check("a dropped connection is a line in the live steps", true);
    await page.locator("#live-steps li", { hasText: "Connected again, so it carried on by itself" }).waitFor({ timeout: 20000 });
    check("…which says it carried on by itself", true);
    const t1 = await page.locator("#live-steps [data-lw-since]").textContent();
    await pause(1200);
    const t2 = await page.locator("#live-steps [data-lw-since]").textContent();
    check("the time so far moves on", t1 !== t2, `${t1} → ${t2}`);
    await page.screenshot({ path: join(OUT, "working.png") });
    await page.locator("#live-steps li", { hasText: "Reading note1.md" }).waitFor({ timeout: 20000 });
    await page.locator("#live-steps [data-act=lw-pause]").click();
    const run = (await api("activity?waiting=1")).find((a) => a.status === "running" || a.task?.why === "run.paused");
    let paused = null;
    for (let i = 0; i < 80 && !paused; i++) { await pause(250); paused = (await api("activity?waiting=1")).find((a) => a.runId === run.runId && a.task?.why === "run.paused"); }
    check("Pause stops the task after its step (engine: run.paused)", !!paused);
    await page.locator("[data-act=lw-resume]").first().waitFor({ timeout: 10000 });
    check("the chat offers Resume and Stop", (await page.locator(".lw-chat [data-act=lw-resume]").count()) === 1 && (await page.locator(".lw-chat [data-act=lw-stop]").count()) === 1);
    await page.screenshot({ path: join(OUT, "paused-chat.png") });
    await page.locator(".side-nav [data-act=view][data-v=inbox]").click();
    const tile = page.locator(".lw-tile");
    await tile.waitFor({ timeout: 10000 });
    check("the Inbox lists it under Running in the background, with Resume", (await tile.locator("[data-act=lw-resume]").count()) === 1, (await tile.textContent()).trim().slice(0, 120));
    await page.screenshot({ path: join(OUT, "paused-inbox.png") });
    await tile.locator("[data-act=lw-resume]").click();
    await page.locator("#conversation").getByText("All four notes are read.").waitFor({ timeout: 30000 });
    const done = (await api(`runs/${run.runId}`)).events;
    const resumed = (await api("activity?waiting=1")).length === 0;
    const all = (await Promise.all(((await api("state")).runs ?? []).map((r) => api(`runs/${r.id}`))));
    const reads = all.flatMap((r) => r.events.filter((e) => e.kind === "tool.started").map((e) => e.data.id));
    check("Resume carries it on to the end, each note read once", resumed && JSON.stringify(reads.sort()) === JSON.stringify(["r1", "r2", "r3", "r4"]), reads.join(","));
    check("the paused task's record says so", done.some((e) => e.kind === "run.paused"));
    await page.screenshot({ path: join(OUT, "finished.png") });
    check("no page errors", errors.length === 0, errors.join("; "));
  } finally {
    await page.close();
    await server.close();
    await app.close();
  }
}

/* A plan limit on the first account: the work moves to "Work", and the chat's live steps say so in plain words. */
async function planSwitch(browser) {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-plan-switch-"));
  const { app, server, api } = await engine(root);
  const { registerCliAgent } = await load("providers/cli-agent.js");
  const { accountsServiceFor } = await load("accounts/service.js");
  /* Claude Code per account folder: the first one is at its plan limit, the others answer after a slow step. */
  const seen = [];
  const spawn = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    if (who === "primary") return { code: 1, stdout: "", stderr: "Claude usage limit reached." };
    await pause(2500);
    return { code: 0, stdout: JSON.stringify({ result: "Done on the other plan." }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  accountsServiceFor(app.runtime.models).deps.spawnAgent = spawn;
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    const lists = await api("accounts");
    check("several accounts per connection ships on", lists.mode !== "off", lists.mode);
    const added = await api("accounts/add", { pool: "cli-claude-code", label: "Work" });
    const work = added.accounts?.find((a) => a.label === "Work")?.id;
    check("an account is added with nothing switched on by hand", Boolean(work), JSON.stringify(added).slice(0, 160));
    await api("accounts/update", { pool: "cli-claude-code", account: work, keptSeparate: true });
    await signIn(page, server);
    await page.fill("#prompt", "tidy my notes");
    await page.locator("#send").click();
    const moved = page.locator("#live-steps li", { hasText: "Moved the work to the account “Work”" });
    await moved.waitFor({ timeout: 20000 });
    const line = (await moved.textContent()).trim();
    check("the chat says plainly that the work moved to another plan", /reached its plan limit; nothing to do/.test(line), line);
    await page.screenshot({ path: join(OUT, "plan-switch.png") });
    await page.locator("#conversation").getByText("Done on the other plan.").waitFor({ timeout: 20000 });
    check("the work finished on the other plan", JSON.stringify(seen) === JSON.stringify(["primary", work]), seen.join(","));
    /* After the task: one quiet line stays in the conversation, and the model chip names the account in use, both as the
       engine has them, after a reload too. */
    const run = ((await api("state")).runs ?? []).find((r) => r.prompt === "tidy my notes");
    const kept = (await api(`runs/${run.id}/steps`)).switched?.[0]?.sentence ?? "";
    const here = await api(`accounts/session?sessionId=${run.sessionId}`);
    for (const when of ["after the task", "after a reload"]) {
      if (when === "after a reload") {
        await page.reload();
        await page.locator("#side").getByText("tidy my notes").first().click();
        await page.locator("#conversation").getByText("Done on the other plan.").waitFor({ timeout: 20000 });
      }
      const quiet = page.locator("#conversation .switched18");
      await quiet.first().waitFor({ timeout: 20000 });
      check(`the move stays as one quiet line ${when}`, (await quiet.count()) === 1 && (await quiet.textContent()).includes(kept) && kept.startsWith("Switched to “Work”"), kept);
      const chip = page.locator('[data-act="modelmenu2"] .lbl');
      await page.waitForFunction(() => /· Work/.test(document.querySelector('[data-act="modelmenu2"] .lbl')?.textContent ?? ""), null, { timeout: 20000 }).catch(() => undefined);
      check(`the model chip names the account in use ${when}`, here.chosenHere === true && (await chip.textContent()).includes(`· ${here.label}`), await chip.textContent());
    }
    await page.screenshot({ path: join(OUT, "plan-switch-kept.png") });
    check("no page errors (plan switch)", errors.length === 0, errors.join("; "));
  } finally {
    await page.close();
    await server.close();
    await app.close();
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await dropPauseResume(browser);
    await planSwitch(browser);
  } finally {
    await browser.close();
  }
  console.log(`frames in ${OUT}`);
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
