/**
 * Translations (fr, es, de) for the live-step and plan-switch lines. The engine keeps saying each line in English and
 * sends the line's words by their key in public/locales (src/live-steps.ts `Said`); the window says the key in the
 * language chosen (public/app/chat/livesteps.js `said`).
 *
 * Mutations: change any of these English words in en.json, or in src/live-steps.ts, and the first test is red; drop
 * `say` from a state line (stateLine) and the key is missing from what was seen; in `said`, skip the plural form or
 * the unit names and the German lines are red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { liveSteps, resultWords } from "../dist/live-steps.js";
import { switchedLines } from "../dist/run-steps.js";

const en = JSON.parse(readFileSync(new URL("../public/locales/en.json", import.meta.url), "utf8"));
/** en.json's words for a Said, filled the English way: the one or other form, numbers and lengths of time in English. */
function english(said) {
  const values = said.values ?? {};
  const key = typeof values.count === "number" ? `${said.key}.${new Intl.PluralRules("en").select(values.count)}` : said.key;
  assert.equal(typeof en[key], "string", `${key} is in en.json`);
  return en[key].replace(/\{(\w+)\}/g, (whole, name) => {
    const value = values[name];
    if (typeof value === "number") return value.toLocaleString("en-US");
    if (value && typeof value === "object") return new Intl.NumberFormat("en", { style: "unit", unit: value.unit, unitDisplay: "long" }).format(value.amount);
    return name in values ? String(value) : whole;
  });
}

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-words-"));
  const provider = { name: "stand-in", complete: async () => ({ content: "ok", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, dataDir: join(root, "data") };
}

test("every line that carries its words' key says, in en.json's words, exactly the engine's English", async (t) => {
  const { app } = await branch(t);
  const run = app.store.createRun(app.runtime.owner, "long work");
  const prior = app.store.createRun(app.runtime.owner, "before the restart");
  app.store.event(prior.id, "run.auto_resumed", {});
  const note = (kind, data = {}) => app.store.event(run.id, kind, data);
  // What a tool call came to, in each shape the engine has words for.
  const tools = [["web.search", [{}, {}, {}]], ["files.search", { matches: [{}] }], ["web.fetch", { text: "one two three" }],
    ["files.read", { content: "a\nb" }], ["files.list", { entries: new Array(1234).fill(0) }], ["files.write", { ok: true }]];
  for (const [at, [name, result]] of tools.entries()) {
    note("tool.started", { id: `c${at}`, name });
    note("tool.completed", { id: `c${at}`, name, result });
  }
  // What happened to the task itself: every kind of state line, and each way a wait ends.
  note("model.limit_wait", {});
  note("model.completed", {});
  note("model.account_limit", { label: "Home" });
  note("model.limit_wait", { until: "2026-09-27T12:00:00Z" });
  note("model.completed", {});
  note("model.network_retry", { delayMs: 1000, attempt: 1, of: 3 });
  note("model.network_retry", { delayMs: 120_000, attempt: 2, of: 3 });
  note("model.reconnected", {});
  note("model.retry_scheduled", { delayMs: 30_000 });
  note("model.stall_recovery", { action: "retry", afterMs: 60_000 });
  note("model.stall_recovery", { action: "fallback", afterMs: 45_000 });
  note("model.fallback", { model: "small-model", reason: "The service said no" });
  // Account pools: each reason the work moved to another account (src/accounts/pool-provider.ts sayMoved).
  note("model.account_moved", { label: "Work", from: "Home", reason: "limit", until: "2026-09-27T15:00:00Z", known: true });
  note("model.account_moved", { label: "Work", from: "Home", reason: "billing" });
  note("model.account_moved", { label: "Work", from: "Home", reason: "auth" });
  note("model.account_moved", { label: "Work", from: "Home", reason: "model", model: "m1" });
  note("model.account_moved", { label: "Work", from: "Home" });
  note("model.account_limit", { label: "Work" });
  note("model.account", { label: "Home" });
  note("run.pause_asked", {});
  note("run.resumed", { from: prior.id, unknownToolOutcomes: 1 });
  note("run.resumed", { from: "elsewhere" });
  note("context.compacted", {});
  // A second task still waiting: its lines say what it is waiting for, and a dropped line what it will do next.
  const waiting = app.store.createRun(app.runtime.owner, "still waiting");
  app.store.event(waiting.id, "model.limit_wait", {});
  const dropped = app.store.createRun(app.runtime.owner, "line dropped");
  app.store.event(dropped.id, "model.network_retry", { delayMs: 1000, attempt: 1, of: 3 });
  app.store.event(dropped.id, "model.network_retry", { delayMs: 120_000, attempt: 2, of: 3 });
  const deps = { thoughtsOf: () => [], waiting: [], helperName: () => null };
  const steps = [run, waiting, dropped].flatMap((one) => liveSteps(app.store, one.id, deps).steps);
  const seen = new Set();
  for (const step of steps) {
    for (const part of ["label", "result"]) {
      const said = step.say?.[part];
      if (!said) continue;
      seen.add(said.key);
      assert.equal(english(said), step[part], `${said.key} (${step.id} ${part})`);
    }
  }
  assert.equal(steps.find((s) => s.label === "Moved to small-model")?.result, "The service said no", "a service's own reason stays as it came");
  assert.equal(steps.find((s) => s.label === "Moved to small-model")?.say?.result, undefined, "and carries no key");
  const moved = switchedLines(app.store.events(run.id));
  assert.equal(moved.length, 6);
  for (const line of moved) { seen.add(line.say.key); assert.equal(english(line.say), line.sentence); }
  // Every key the engine may send was sent here, so none of them is left unchecked ("Running …" is below).
  const keys = new Set(Object.keys(en).filter((k) => k.startsWith("window.chat.live.") && !/\.(show-all|worked|worked-one|working|running|reconnecting-updates)$/.test(k))
    .map((k) => k.replace(/\.(one|other)$/, "")));
  assert.deepEqual([...keys].filter((k) => !seen.has(k)), [], "every live-step key was produced and checked");
  assert.equal(english({ key: "window.chat.live.running", values: { command: "npm test" } }), "Running npm test");
  assert.equal(resultWords("something.new", {}), null);
});

test("the window says those lines in German, Spanish and French, and keeps the engine's English otherwise", async (t) => {
  const { app, dataDir } = await branch(t);
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: "networkidle" });
  const sayIn = (language, cases) => page.evaluate(async ([language, cases]) => {
    const words = await import("/i18n.js");
    await words.initLanguage(); // the page's own start is done first, so nothing loads English over the language asked for
    await words.setLanguage(language);
    const { said } = await import("/app/chat/livesteps.js");
    return cases.map(([say, english]) => said(say, english));
  }, [language, cases]);
  const cases = [
    [{ key: "window.chat.live.moved-limit", values: { to: "Work", from: "Home" } }, "Moved to “Work” — “Home” hit its limit"],
    [{ key: "window.chat.live.trying-again", values: { time: { amount: 2, unit: "minute" }, attempt: 2, of: 3 } }, "Trying again in 2 minutes (2 of 3); nothing to do"],
    [{ key: "window.chat.live.found-results", values: { count: 1 } }, "Found 1 result"],
    [{ key: "window.chat.live.items", values: { count: 1234 } }, "1,234 items"],
    [{ key: "window.chat.live.moved-limit-at", values: { to: "Work", from: "Home", time: "15:00" } }, "Moved to “Work” — “Home” hit its limit, resets 15:00"],
    [{ key: "window.chat.live.not-a-key-yet" }, "Words from a newer engine"],
    [null, "A line with no key"],
  ];
  assert.deepEqual(await sayIn("de", cases), [
    "Zu „Work“ gewechselt – „Home“ hat sein Limit erreicht", "Neuer Versuch in 2 Minuten (2 von 3); nichts zu tun", "1 Ergebnis gefunden",
    "1.234 Einträge", "Zu „Work“ gewechselt – „Home“ hat sein Limit erreicht, wieder frei um 15:00", "Words from a newer engine", "A line with no key"]);
  const [es] = await sayIn("es", cases.slice(1, 2));
  assert.equal(es, "Se intenta de nuevo en 2 minutos (2 de 3); no tienes que hacer nada");
  const [fr] = await sayIn("fr", cases.slice(2, 3));
  assert.equal(fr, "1 résultat trouvé");
  assert.deepEqual(await sayIn("en", cases), cases.map(([, english]) => english), "English is the engine's own words");
  assert.deepEqual(errors, []);
});

test("while task updates cannot be reached the live block says it is reconnecting, and keeps trying", async (t) => {
  const { app, dataDir } = await branch(t);
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: "networkidle" });
  const seen = await page.evaluate(async () => {
    const words = await import("/i18n.js");
    await words.initLanguage();
    let asked = 0;
    const real = window.fetch;
    window.fetch = (url, ...rest) => String(url).includes("/live") ? (asked++, Promise.reject(new TypeError("Failed to fetch"))) : real(url, ...rest);
    const { liveFollower } = await import("/app/chat/livesteps.js");
    document.body.insertAdjacentHTML("beforeend", '<div id="probe-scroll"><div id="probe-steps"></div></div>');
    const follower = liveFollower({ block: "probe-steps", scroll: "#probe-scroll" });
    follower.follow("run-that-cannot-be-reached");
    for (let i = 0; i < 50 && !document.getElementById("probe-steps").textContent; i++) await new Promise((done) => setTimeout(done, 100));
    const result = { text: document.getElementById("probe-steps").textContent, shown: follower.shown(), asked };
    follower.forget();
    window.fetch = real;
    return result;
  });
  assert.match(seen.text, /Reconnecting to task updates/);
  assert.equal(seen.shown, true, "the block shows even before the first step");
  assert.ok(seen.asked >= 1);
  assert.deepEqual(errors, []);
});

test("a question still waiting stays in view with its helper when newer steps fold the older ones away", async (t) => {
  const { app, dataDir } = await branch(t);
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: "networkidle" });
  const labels = await page.evaluate(async () => {
    const words = await import("/i18n.js");
    await words.initLanguage();
    const step = (id, extra) => ({ id, kind: "tool", state: "done", depth: 0, icon: "*", label: `Step ${id}`, ...extra });
    const steps = [step("h", { kind: "helper", label: "Helper Ada" }), step("q", { kind: "ask", state: "waiting", depth: 1, label: "May I send it?" }),
      ...Array.from({ length: 12 }, (_, i) => step(`s${i}`, { label: `Newer step ${i}` }))];
    const body = `event: steps\ndata: ${JSON.stringify({ runId: "run-q", status: "running", steps, total: steps.length })}\n\nevent: end\ndata: {}\n\n`;
    const real = window.fetch;
    window.fetch = (url, ...rest) => String(url).includes("/live") ? Promise.resolve(new Response(body)) : real(url, ...rest);
    const { liveFollower } = await import("/app/chat/livesteps.js");
    document.body.insertAdjacentHTML("beforeend", '<div id="probe-scroll"><div id="probe-steps"></div></div>');
    const follower = liveFollower({ block: "probe-steps", scroll: "#probe-scroll" });
    follower.follow("run-q");
    for (let i = 0; i < 50 && !document.querySelector("#probe-steps li"); i++) await new Promise((done) => setTimeout(done, 100));
    const seen = [...document.querySelectorAll("#probe-steps .ls-t")].map((el) => el.textContent);
    follower.forget();
    window.fetch = real;
    return seen;
  });
  assert.deepEqual(labels.slice(0, 2), ["Helper Ada", "May I send it?"], "the waiting question and its helper stay, in order");
  assert.ok(labels.includes("Newer step 11") && !labels.includes("Newer step 0"), "the newest steps still show and older ones fold");
  assert.deepEqual(errors, []);
});
