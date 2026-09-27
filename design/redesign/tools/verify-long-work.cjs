/* Long work: a task that loses its connection shows it in its live steps and carries on; its time so far and Pause sit
   over the steps; Pause stops it after the step it is on (checked through GET /api/activity?waiting=1); the chat and the
   Inbox's "Running in the background" then offer Resume, which carries it on to the end with nothing done twice
   (checked through GET /api/runs/<id>). Starts its own engine in this process on PORT (default 3815) with a stand-in
   model whose first call drops the connection and whose steps are slow, then drives the window and saves frames.
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

(async () => {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-long-work-"));
  const dist = join(__dirname, "../../../dist");
  const { createBranch } = await import("file:///" + join(dist, "index.js").replace(/\\/g, "/"));
  const { startServer } = await import("file:///" + join(dist, "server.js").replace(/\\/g, "/"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  for (let n = 1; n <= 4; n++) writeFileSync(join(workspace, `note${n}.md`), `note ${n}\n`);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: PORT });
  const api = async (path, body) => (await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(server.url + "/");
    await page.getByLabel("Session token").fill(server.token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#prompt").waitFor();
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
    await page.goto(server.url + "/#inbox");
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
    await browser.close();
    await server.close();
    await app.close();
  }
  console.log(`frames in ${OUT}`);
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
