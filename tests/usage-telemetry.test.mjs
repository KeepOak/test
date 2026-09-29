// Bucket 14: what it has cost you, in plain figures.
// U1-U3 the usage report (A0367), U4 the task counters sent to your own collector (A1751),
// U5 handing events to an embedding program's logger (A1334), U6 the written guides (A1334, A0681).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, afterTaskMetrics, bridgeLogs, change, executionMetricsDeps, executionMetricsSettings, levelFor, money, rollUp,
  saveExecutionMetricsSettings, saveTraceExportSettings, sendExecutionMetrics, usageReportSettings,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

const plantedKey = "sk-testonly0000ZZZZ1111secretvalue"; // not-a-real-secret: a planted fixture that must be blanked

function scripted(steps) {
  let calls = 0;
  return {
    name: "scripted",
    async complete() { const step = steps[Math.min(calls, steps.length - 1)]; calls += 1; return step(); },
  };
}
const say = (content) => () => ({ content, toolCalls: [] });
const write = (id) => () => ({ content: "", toolCalls: [{ id, name: "files.write", arguments: JSON.stringify({ path: `${id}.txt`, content: "x" }) }] });

async function served(t, steps = [say("done")], serverOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-usage14-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps),
    web: { allowPrivateAddresses: true },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), ...serverOptions, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, api, url: server.url };
}

/** The model the scripted runs were recorded under, so a price can be put on it. */
function recordedModel(app, runId) {
  const event = app.store.events(runId).find((e) => e.kind === "model.completed");
  return String(event?.data.model ?? "");
}

/** Moves a finished task back in time, with its events, so it falls in the stretch before. */
function backdate(app, runId, days) {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  app.store.sqlite.prepare("UPDATE tasks SET created_at=?, updated_at=? WHERE id=?").run(at, at, runId);
  app.store.sqlite.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(at, runId);
}

// ------------------------------------------------------------ U1-U3: the usage report

test("U1: the usage report ships when needed; switched off it refuses in one sentence until switched on", async (t) => {
  const { app, api } = await served(t);
  // The ship-on rule: the report ships "when needed" (src/usage-report.ts).
  assert.equal(usageReportSettings(app.store, app.runtime.owner).mode, "when-needed");
  const settings = await api("GET", "/api/usage/report/settings");
  assert.equal(settings.body.usageReport.mode, "when-needed");
  // The owner switches it off through its own route, so the off is theirs.
  assert.equal((await api("POST", "/api/usage/report/settings", { mode: "off" })).body.usageReport.mode, "off");
  const refused = await api("POST", "/api/usage/report", { range: "7d" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /switched off/);
  const on = await api("POST", "/api/usage/report/settings", { mode: "when-needed" });
  assert.equal(on.body.usageReport.mode, "when-needed");
  assert.equal(on.body.usageReport.enabled, true);
  const ranged = await api("POST", "/api/usage/report/settings", { range: "7d" });
  assert.equal(ranged.body.usageReport.mode, "when-needed", "saving one field keeps the switch where it was");
  assert.equal((await api("POST", "/api/usage/report/settings", { range: "1y" })).status, 400);
});

test("U2: the report adds up the stretch, compares it with the one before, and names tools and people", async (t) => {
  const { app, api } = await served(t, [write("a"), say("one"), write("b"), say("two"), say("three")]);
  const first = await app.runtime.run({ prompt: "first" });
  const second = await app.runtime.run({ prompt: `second ${plantedKey}` });
  const old = await app.runtime.run({ prompt: "an older one" });
  assert.equal(first.status, "completed", first.output);
  backdate(app, old.id, 10);
  const model = recordedModel(app, first.id);
  assert.ok(model, "the scripted task recorded which model answered");
  await api("POST", "/api/pricing", { overrides: { [model]: { input: 1000, output: 1000 } } });
  const sam = app.store.profiles.create({ name: "Sam", pin: "4821" });
  app.store.sqlite.prepare("UPDATE tasks SET owner=? WHERE id=?").run(`profile:${sam.id}`, second.id);
  await api("POST", "/api/usage/report/settings", { mode: "on" });

  const page = await api("POST", "/api/usage/report", { range: "7d", format: "markdown" });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const text = page.body.body;
  assert.equal(page.body.format, "markdown");
  assert.match(text, /# Usage report, last 7 days/);
  assert.match(text, /finished 2 task\(s\), up 100% on the 7 days before \(1\)/);
  assert.match(text, /Estimated cost: \$\d+\.\d\d for the 2 task\(s\) with a price on file/);
  assert.match(text, /not a bill/);
  assert.match(text, /## By model\n\n- [^\n]*2 task\(s\)/);
  assert.match(text, /## Tools used most\n\n- files\.write: 2 call\(s\)/);
  assert.match(text, /## By where tasks came from/);
  assert.match(text, /## By person on this computer\n\n- Sam: 1 task\(s\)[^\n]*\n- You \(the owner\): 1 task\(s\)/);
  assert.match(text, /made 2 tool call\(s\)/, "a call's start and end count once");
  assert.doesNotMatch(text, /4821/, "a profile's PIN never appears");
  assert.doesNotMatch(text, /second/, "no prompt is in the report");
  assert.ok(!text.includes(plantedKey));

  const html = await api("POST", "/api/usage/report", { range: "30d" });
  assert.equal(html.body.format, "html");
  assert.match(html.body.body, /^<!doctype html>/);
  assert.match(html.body.body, /finished 3 task\(s\), new compared with the 30 days before/);
  assert.doesNotMatch(html.body.body, /<script/i);
});

test("U3: a task with no price is said so in words, and the sums keep unknown apart from zero", () => {
  const day = (date, runs, priced, cost, model) => ({
    date, runs, toolCalls: 1, failures: 0, tokens: { input: 10, output: 5 }, estimatedCost: cost,
    pricedRuns: priced, unpricedRuns: runs - priced, topFailures: [],
    presets: [{ id: model, model, runs, tokens: { input: 10, output: 5 }, cost: priced ? cost : null }],
    byConversation: [], byChannel: [{ source: "web", runs, cost: priced ? cost : null }],
  });
  const stretch = rollUp([day("2026-09-02", 2, 0, 0, "mystery"), day("2026-09-01", 1, 1, 0.5, "known")]);
  assert.equal(stretch.tasks, 3);
  assert.equal(stretch.pricedTasks, 1);
  assert.equal(stretch.unpricedTasks, 2);
  assert.equal(stretch.cost, 0.5);
  assert.deepEqual(stretch.days.map((d) => d.date), ["2026-09-01", "2026-09-02"]);
  assert.equal(stretch.models.find((m) => m.name === "mystery").cost, null, "unknown is not zero");
  assert.equal(stretch.channels[0].cost, 0.5);
  assert.equal(money(null), "no price on file");
  assert.equal(money(0.001), "less than $0.01");
  assert.equal(money(0), "$0.00");
  assert.equal(change(12, 10), "up 20% on");
  assert.equal(change(5, 10), "down 50% on");
  assert.equal(change(0, 0), "the same as");
  assert.equal(change(3, 0), "new compared with");
});

// ------------------------------------------------------------ U4: the task counters

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), "waited too long");
}

function memoryStore() {
  const saved = new Map();
  return {
    get: (_kind, owner, key) => (saved.has(`${owner}/${key}`) ? { data: saved.get(`${owner}/${key}`) } : undefined),
    save: (_kind, owner, key, data) => { saved.set(`${owner}/${key}`, data); },
  };
}

test("U4: the counters switch ships when needed; off sends nothing, when needed sends on a press, and after tasks only when on", async () => {
  const store = memoryStore();
  const sent = [];
  let clock = new Date("2026-09-17T10:00:00Z");
  let tracesOn = false;
  const deps = {
    store, owner: "local", now: () => clock,
    sendingOn: () => tracesOn,
    counters: () => [{ name: "branch_runs_total", description: "Tasks", unit: "1", value: 4 }],
    send: async (points, reason) => { sent.push({ points, reason }); return { ok: true, error: null }; },
  };
  // The ship-on rule: the counters ship "when needed" (src/execution-metrics.ts); the owner switches them off through their own save.
  assert.equal(executionMetricsSettings(store, "local").mode, "when-needed");
  saveExecutionMetricsSettings(store, "local", { mode: "off" });
  assert.equal(executionMetricsSettings(store, "local").mode, "off");
  assert.match((await sendExecutionMetrics(deps)).reason, /switched off/);
  assert.equal((await afterTaskMetrics(deps)).sent, false);

  saveExecutionMetricsSettings(store, "local", { mode: "when-needed" });
  assert.equal((await afterTaskMetrics(deps)).sent, false, "when needed never sends by itself");
  assert.match((await sendExecutionMetrics(deps)).reason, /no address of yours/, "nothing goes while traces are off");
  assert.equal(sent.length, 0);
  tracesOn = true;
  assert.equal((await sendExecutionMetrics(deps)).sent, true);
  assert.equal(sent.length, 1);

  saveExecutionMetricsSettings(store, "local", { mode: "on", minutesBetween: 10 });
  assert.equal((await afterTaskMetrics(deps)).sent, false, "inside the quiet gap after the press");
  clock = new Date("2026-09-17T10:11:00Z");
  assert.equal((await afterTaskMetrics(deps)).sent, true);
  assert.equal((await afterTaskMetrics(deps)).sent, false);
  assert.equal(sent.length, 2);
  assert.throws(() => saveExecutionMetricsSettings(store, "local", { lastSentAt: "x" }), "the send time is not a setting");
});

test("U4: after a task the counters reach the owner's own collector, carrying numbers only", async (t) => {
  const seen = [];
  const collector = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { seen.push({ path: request.url, body: raw }); response.writeHead(200); response.end("{}"); });
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => collector.close(resolve)));
  const { app, api } = await served(t, [say(`finished ${plantedKey}`)]);
  // The ship-on rule: the counters ship "when needed"; the owner switches them off through their own route.
  assert.equal((await api("GET", "/api/usage/counters")).body.counters.mode, "when-needed");
  const off = await api("POST", "/api/usage/counters", { mode: "off" });
  assert.equal(off.body.counters.mode, "off");

  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, destination: "otlp", endpoint: `http://127.0.0.1:${collector.address().port}` });
  const quiet = await app.runtime.run({ prompt: "a private prompt about Sam" });
  await waitFor(() => app.store.events(quiet.id).some((e) => e.kind === "trace.sent" || e.kind === "trace.send_failed"));
  assert.equal(seen.filter((s) => s.path === "/v1/metrics").length, 0, "the counters stay home while their switch is off");

  await api("POST", "/api/usage/counters", { mode: "on" });
  await app.runtime.run({ prompt: "a private prompt about Sam" });
  await waitFor(() => seen.some((s) => s.path === "/v1/metrics"));
  const metrics = seen.find((s) => s.path === "/v1/metrics");
  assert.ok(metrics, "the counters arrived at the owner's address");
  assert.match(metrics.body, /branch_runs_total/);
  assert.match(metrics.body, /branch_tool_failures_total/);
  assert.doesNotMatch(metrics.body, /private prompt|Sam|sk-testonly/);
  const pressed = await api("POST", "/api/usage/counters/send", {});
  assert.equal(pressed.body.sent, true, pressed.body.reason);
  assert.ok(pressed.body.counters.lastSentAt);
  const record = app.store.audit.list(app.runtime.owner, { action: "data.exported" });
  assert.ok(record.some((entry) => /counters/.test(entry.reason)), "every send is written in the record");
});

// ------------------------------------------------------------ U5: the log bridge

test("U5: events reach the embedding program's logger at the right level, cut down to their shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-logs14-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([write("c"), say("ok")]) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const lines = [];
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) =>
    [level, (message, fields) => lines.push({ level, message, fields })]));
  const stop = bridgeLogs(app.store, logger, { prefix: "agent" });
  await app.runtime.run({ prompt: `please keep ${plantedKey} private` });
  stop();
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => l.message === "agent tool.completed" && l.fields.name === "files.write"));
  assert.ok(lines.every((l) => l.level !== "debug"), "debug lines are left out at the default level");
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(plantedKey), "no key reaches the logger");
  assert.ok(!all.includes("please keep"), "no prompt reaches the logger");
  const count = lines.length;
  app.store.event(lines[0].fields.runId, "tool.completed", { name: "late" });
  assert.equal(lines.length, count, "stopping the bridge stops the lines");

  const failures = [];
  const only = bridgeLogs(app.store, { ...logger, error: (m) => failures.push(m), info: () => { throw new Error("broken logger"); } },
    { kinds: ["tool."], level: "warn" });
  app.store.event(lines[0].fields.runId, "tool.failed", { name: "x", error: "no" });
  app.store.event(lines[0].fields.runId, "tool.completed", { name: "y" });
  app.store.event(lines[0].fields.runId, "model.failed", { error: "no" });
  only();
  assert.deepEqual(failures, ["branch tool.failed"], "kinds and level both narrow, and a throwing logger breaks nothing");
  assert.equal(levelFor("model.retry_scheduled"), "warn");
  assert.equal(levelFor("model.stall_recovery"), "warn");
  assert.equal(levelFor("text.delta"), "debug");
  assert.equal(levelFor("run.started"), "info");
});

// ------------------------------------------------------------ U6: the guides

test("U6: the builders' guide says how to log, and the settings page explains the counters and startup tracing", async () => {
  const guide = await readFile(new URL("../docs/handbook/07-for-builders.md", import.meta.url), "utf8");
  assert.match(guide, /## Logging from a program that embeds Branch/);
  assert.match(guide, /bridgeLogs\(app\.store, console/);
  assert.match(guide, /GET \/api\/logs/);
  const docs = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  const has = (pattern) => assert.ok(pattern.test(docs), `configuration.md says ${pattern}`);
  has(/### Usage report, task counters and logging \(A0367, A1751, A1334, A0681\)/);
  has(/There is no telemetry, and there never will be/);
  has(/tracing starts with\s+the\s+engine/);
});

// ------------------------------------------------------------ U7-U8: the two cards

// Redesign: replaced by the new window (/usage-report.js and its keys are gone with the old window; the prototype's words
// are its own), and French waits on sw:lang, Coming soon, checked at fc541c24.
test.skip("U7: every word the two cards show is on file in English and in real French", async () => {
  const script = await readFile(new URL("../public/usage-report.js", import.meta.url), "utf8");
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const keys = new Set([...script.matchAll(/["'`]((?:usage\.report\.|counters\.|action\.usage-report-|action\.counters-|field\.usage-report-|field\.counters-)[\w.-]*)["'`]/g)].map((m) => m[1]));
  /* DG-017: both mode switches are the shared Off · When needed · On, whose words are the switch's own. */
  for (const range of ["7d", "30d", "90d"]) keys.add(`usage.report.range.${range}`);
  keys.delete("usage.report.range");
  assert.ok(keys.size >= 18, `the script's keys were not found (${keys.size})`); // 18 since DG-017 took the six mode words
  for (const key of keys) {
    assert.ok(english[key], `${key} has no English`);
    assert.ok(french[key] && french[key] !== english[key], `${key} has no French of its own`);
  }
  assert.ok(!/textContent = "[A-Z]/.test(script), "a word is written into the page without a key");
  assert.ok(!/#[0-9a-f]{3,6}\b|rgba?\(/i.test(script), "no colour is written down");
});

/* The new window: Settings › Data & usage's report is the prototype's. Since parity B5 it adds up the engine's own usage
   (GET /api/usage, public/app/settings/pages/usage.js), not the usage report, which ships when needed: "Open the report"
   shows the task that ran, at 400 pixels, with no page errors. The engine's answer is held back a little, as a busy
   machine does: pressed before it lands, the report used to add up nothing ("0" tasks) and now waits for it.
   Mutation: in usage.js make repopen15 call openReport() without awaiting the read, and this goes red. */
test("U8: the report lives in Data & usage and adds up the engine's own usage, at 400 pixels", async (t) => {
  const { settingsWindow, openSettingsPage } = await import("./settings-window.mjs");
  const slowUsage = (page) => page.route(/\/api\/usage\?range=/, async (route) => { await new Promise((done) => setTimeout(done, 800)); await route.continue(); });
  const { app, page, errors } = await settingsWindow(t, { name: "ui14", width: 400, height: 800, provider: scripted([say("done")]), route: slowUsage,
    before: (one) => one.runtime.run({ prompt: "one task" }) });
  assert.equal(usageReportSettings(app.store, app.runtime.owner).mode, "when-needed", "ships when needed (the ship-on rule)");
  await openSettingsPage(page, "usage");
  const open = page.locator(".set-col").getByRole("button", { name: "Open the report", exact: true });
  await open.waitFor();
  await open.click();
  const report = page.locator(".dlg .rp-top15");
  await report.waitFor({ timeout: 10000 });
  const tasks = await report.locator("div", { has: page.locator("small", { hasText: "Tasks" }) }).locator("b").innerText();
  assert.equal(tasks.trim(), "1", "the one task that ran is counted");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, "the page does not scroll sideways");
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------ integration review (mac4/bucket-14)

test("U9: a short-lived key cannot make the usage report, flip its switches, or send the counters", async (t) => {
  // Eight refusals in a row would otherwise trip the lock on wrong keys, which is not what is tested here.
  const { app, api, url } = await served(t, undefined, { authLimits: { attempts: 100 } });
  await api("POST", "/api/usage/report/settings", { mode: "on" });
  // The counters ship "when needed" (the ship-on rule); the owner puts them off, so a refused "on" is seen to change nothing.
  assert.equal((await api("POST", "/api/usage/counters", { mode: "off" })).body.counters.mode, "off");
  const doors = [
    ["/api/usage/report", { range: "7d" }], ["/api/usage/report/settings", { mode: "off" }],
    ["/api/usage/counters", { mode: "on" }], ["/api/usage/counters/send", {}],
  ];
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { scope, minutes: 5 });
    for (const [path, body] of doors) {
      const answer = await fetch(`${url}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(answer.status, 401, `${scope} ${path}`);
      assert.match((await answer.json()).error, /short-lived key cannot make the usage report/, `${scope} ${path}`);
    }
  }
  assert.equal(usageReportSettings(app.store, app.runtime.owner).mode, "on", "the switch stayed where the owner put it");
  assert.equal(executionMetricsSettings(app.store, app.runtime.owner).mode, "off");
  assert.equal((await api("POST", "/api/usage/report", { range: "7d" })).status, 200, "the owner's own key still makes it");
});

test("U10: a tool call counts once whether it finished, failed, stalled or was run by hand", async (t) => {
  const { app } = await served(t);
  const run = await app.runtime.run({ prompt: "nothing to do" });
  const event = (kind, data) => app.store.event(run.id, kind, data);
  event("tool.started", { name: "a", id: "1" }); event("tool.completed", { name: "a", id: "1" });
  event("tool.started", { name: "b", id: "2" }); event("tool.failed", { name: "b", id: "2", error: "no" });
  event("tool.started", { name: "c", id: "3" }); event("tool.stalled", { name: "c", id: "3", error: "slow" });
  event("tool.started", { name: "d", manual: true }); event("tool.completed", { name: "d" });
  const days = app.store.usageStore().aggregateUsage("30d", "day", {});
  const toolCalls = days.reduce((sum, day) => sum + day.toolCalls, 0);
  assert.equal(toolCalls, 4, "four calls, not eight");
  assert.equal(days.reduce((sum, day) => sum + day.failures, 0), 1);
});

test("U11: the counters go nowhere the address rules refuse, and the refusal is written in the record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage14p-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([say("ok")]) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  let reached = 0;
  const deps = executionMetricsDeps(app.store, app.runtime.owner, app.traceExport);
  saveExecutionMetricsSettings(app.store, app.runtime.owner, { mode: "when-needed" });
  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, destination: "otlp", endpoint: "http://127.0.0.1:9/" });
  const outcome = await sendExecutionMetrics({ ...deps, send: async (points, reason) => { reached += 1; return deps.send(points, reason); } });
  assert.equal(outcome.sent, false, outcome.reason);
  assert.match(outcome.reason, /Allow private addresses/, "refused by the address rules, not by a closed port");
  assert.equal(reached, 1);
  const record = app.store.audit.list(app.runtime.owner, { action: "data.exported" });
  assert.ok(record.some((entry) => entry.outcome === "failed" && /counters/.test(entry.reason)), JSON.stringify(record));
  assert.equal(executionMetricsSettings(app.store, app.runtime.owner).lastSentAt, undefined, "a refused send is not a send");
  assert.ok(deps.counters().every((point) => typeof point.value === "number" && Object.keys(point).sort().join() === "description,name,unit,value"));
});
