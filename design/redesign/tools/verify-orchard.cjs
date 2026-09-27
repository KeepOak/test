/* Orchard (Automations › Orchard): starts its own engine in this process on PORT (default 3470) with a stand-in model
   and two Trunks, then drives the window in a headless browser (never a visible window): a chat's card planted, grown
   and picked; a card dragged onto a Trunk's face; a new card whose question is answered on the card by its fingerprint
   and ripens as the same task; a card that waits for another; Stop from the card. Every step is checked through
   GET /api/orchard, and frames are saved to OUT.
   Run: npm run build, then PORT=3470 OUT=<folder> node design/redesign/tools/verify-orchard.cjs */
const { chromium } = require("playwright");
const { existsSync, mkdtempSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const PORT = Number(process.env.PORT || 3470);
const OUT = process.env.OUT || join(tmpdir(), "verify-orchard");
mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const until = async (test, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await new Promise((r) => setTimeout(r, 60)); } return false; };

const allowedNote = /The call you asked about did not run/;
let hold = null;
/* "Done." for a card; "write <file>" writes it (again after a yes); "slow" waits until stopped, so Stop has a task. */
const model = { name: "scripted", async complete(request) {
  const all = request.messages.map((m) => String(m.content ?? "")).join("\n"), last = request.messages.at(-1), text = String(last?.content ?? "");
  // Waits until released or stopped: a real model's call ends when its task is stopped, so this one does too.
  if (/^slow$/m.test(all)) await new Promise((resolve, reject) => { hold = resolve; request.signal?.addEventListener("abort", () => reject(request.signal.reason ?? new Error("Stopped"))); });
  const named = /^write (\S+)$/m.exec(all);
  const write = { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named?.[1] ?? "x.txt", content: "hello" }) }] };
  if (named && last?.role === "user") return write;
  if (named && last?.role === "tool" && !/"ok":true/.test(text) && allowedNote.test(String(request.messages[0]?.content ?? ""))) return write;
  return { content: "Done.", toolCalls: [] };
} };

(async () => {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-orchard-"));
  const dist = join(__dirname, "../../../dist");
  const { createBranch, savePolicy } = await import("file:///" + join(dist, "index.js").replace(/\\/g, "/"));
  const { startServer } = await import("file:///" + join(dist, "server.js").replace(/\\/g, "/"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.create({ name: "Flo" });
  const orchard = app.flowsBoards.orchard;
  orchard.add({ title: "Sweep the path" }, { kind: "chat" });
  orchard.add({ title: "Clean the gutters" }, { kind: "chat" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: PORT, host: "127.0.0.1" });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const find = async (title) => Object.values((await call("/api/orchard")).lanes).flat().find((c) => c.title === title);

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", colorScheme: "light" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="automations"]').click();
    await page.locator('#main .place [data-act="ptab"][data-v="board"]').click();
    const place = page.locator("#main .place").first();
    await place.locator(".orc-card").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "1-seed.png") });

    await place.locator(".orc-card", { hasText: "Sweep the path" }).locator('[data-act="orc-plant"]').click();
    check("Plant it grows a chat's card and it ripens", await until(async () => (await find("Sweep the path"))?.lane === "ripe"));
    await place.locator(".orc-card", { hasText: "Sweep the path" }).locator('[data-act="orc-pick"]').click();
    check("Pick picks it", await until(async () => (await find("Sweep the path"))?.lane === "picked"));

    await place.locator(".orc-card", { hasText: "Clean the gutters" }).dragTo(place.locator(`.orc-give[data-orc-to="${ed.id}"]`));
    check("dragged onto Ed's face, it is Ed's", await until(async () => (await find("Clean the gutters"))?.assignee === ed.id));
    check("and it ran as Ed and ripened", await until(async () => (await find("Clean the gutters"))?.lane === "ripe"));

    await place.locator('[data-act="orc-new"]').click();
    await page.locator("#orc-title").fill("write gate.txt");
    await page.locator('[data-act="orc-save"]').click();
    const gate = place.locator(".orc-card", { hasText: "write gate.txt" });
    await gate.locator('.orc-ask [data-act="orc-ask"][data-v="allow"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "2-question-on-card.png") });
    const asked = await find("write gate.txt");
    check("the card shows its own exact question", asked?.lane === "growing" && asked.asks.length === 1 && /^[a-f0-9]{32}$/.test(asked.asks[0].fingerprint));
    await gate.locator('.orc-ask [data-act="orc-ask"][data-v="allow"]').click();
    check("Allow once carries the same task on to ripe", await until(async () => { const c = await find("write gate.txt"); return c?.lane === "ripe" && c.runId === asked.runId; }));
    check("and it did what the yes was for", existsSync(join(root, "workspace", "gate.txt")));

    await place.locator('[data-act="orc-new"]').click();
    await page.locator("#orc-title").fill("slow");
    await page.locator('[data-act="orc-save"]').click();
    const slow = place.locator(".orc-card", { hasText: "slow" });
    await slow.locator('[data-act="orc-stop"]').waitFor({ timeout: 20000 });
    await slow.locator('[data-act="orc-stop"]').click();
    check("Stop on a growing card blocks it (the task's own cancel)", await until(async () => (await find("slow"))?.lane === "blocked"));
    hold?.();

    await place.locator(".orc-card", { hasText: "slow" }).locator('[data-act="orc-title"], [data-act="orc-open"]').first().click();
    await page.locator("#orc-comment").fill("Try again tomorrow");
    await page.locator('[data-act="orc-comment"]').click();
    const slowCard = await find("slow");
    check("a comment is kept on the card", await until(async () => (await call(`/api/orchard/cards/${slowCard.id}`)).comments?.some((c) => c.text === "Try again tomorrow")));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "3-card-open.png") });
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForTimeout(300);
    check("no sideways page scroll at 400 px", await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "4-phone.png") });
    check("no page errors", errors.length === 0, errors.join(" | "));
  } catch (error) {
    failed++;
    console.log(`FAIL ${error.message}`);
  } finally {
    await browser.close();
    await server.close();
    await app.close();
  }
  console.log(failed ? `${failed} failed` : `all passed; frames in ${OUT}`);
  process.exit(failed ? 1 : 0);
})();
