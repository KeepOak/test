/* Settings › Computer & browser and › Permissions, the browser's own switches, each doing what it says against real
   headless Chromium and a local page: Ask before a site it hasn't visited (once per site, never the owner's own
   address), Number the clickable things (off: numbering and pressing by number refuse), Record browser tasks (kept
   when the task ends; kept before the owner takes the window over), and Downloads may come from known sites only. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Budget } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { savePolicy } from "../dist/policy.js";
import { saveComfort } from "../dist/comfort/settings.js";
import { withNewSiteQuestion } from "../dist/comfort/browser-safety.js";

assert.equal(typeof chromium.launch, "function");

async function server(t, handler) {
  const site = createServer(handler);
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  t.after(() => new Promise((done) => site.close(done)));
  return `http://127.0.0.1:${site.address().port}`;
}
async function fixture(t, care) {
  const root = await mkdtemp(join(tmpdir(), "branch-browser-care-"));
  const other = await server(t, (_request, response) => response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=elsewhere.txt" }).end("from elsewhere"));
  const origin = await server(t, (request, response) => {
    if (request.url === "/file.txt") return response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=here.txt" }).end("from here");
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Care</title><label>Name <input id="n"></label>
      <a id="here" href="/file.txt" download>Here</a><a id="there" href="${other}/x.txt" download>There</a>`);
  });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Unused", toolCalls: [] }; } } });
  const browser = new BranchBrowser({ allowedOrigins: [origin, other] });
  browser.store = app.store; browser.files = app.files; browser.artifacts = app.artifacts; app.browser = browser;
  registerBrowser(app.registry, browser);
  t.after(async () => { await browser.close(); await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  if (care) saveComfort(app.store, app.runtime.owner, "browser", care);
  const context = (runId = app.store.createRun(app.runtime.owner, "Care", undefined, false, "window").id) => ({ owner: app.runtime.owner, runId,
    workspace: join(root, "workspace"), signal: new AbortController().signal, budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0 });
  return { app, browser, origin, other, context, root };
}

test("Ask before a site it hasn't visited: a new site asks once, a yes for always is kept for that site, the owner's own address never asks", () => {
  const store = new Map();
  const reader = { get: (_kind, _owner, key) => (store.has(key) ? { data: store.get(key) } : undefined) };
  const policy = { preset: "custom", rules: [{ tool: "browser.navigate", match: "example.org", applies: "any", decision: "allow", remember: "session" },
    { tool: "*", match: "*", applies: "any", decision: "allow", remember: "session" }] };
  assert.equal(withNewSiteQuestion(policy, reader, "o"), policy, "off: nothing changes");
  store.set("comfort-browser", { askNewSites: true });
  const asked = withNewSiteQuestion(policy, reader, "o").rules;
  assert.deepEqual(asked.map((rule) => [rule.tool, rule.match, rule.decision]),
    [["browser.navigate", "example.org", "allow"], ["browser.navigate", "*", "ask"], ["*", "*", "allow"]],
    "a site already said yes to keeps its rule ahead of the question");
  assert.equal(asked[1].remember, "always", "a yes can be kept for that site");
});

test("the setting reaches a task through the runtime, and never the owner's own browser controls", async (t) => {
  const { app } = await fixture(t, { askNewSites: true });
  const task = app.store.createRun(app.runtime.owner, "Task", undefined, false, "window").id;
  const own = app.store.createRun(app.runtime.owner, "Owner browser control", undefined, false, "window").id;
  app.runtime.ownerDriven.add(own);
  const asks = (runId) => app.runtime.policy("owner", runId).rules.some((rule) => rule.tool === "browser.navigate" && rule.decision === "ask" && rule.match === "*");
  assert.equal(asks(task), true);
  assert.equal(asks(own), false);
});

test("Number the clickable things off: numbering and pressing by number refuse, pressing by name still works", async (t) => {
  const { app, origin, context } = await fixture(t, { numberMarks: false });
  const run = context();
  await app.registry.execute("browser.navigate", { url: `${origin}/` }, run);
  await assert.rejects(app.registry.execute("browser.annotate", {}, run), /Numbering what's on a page is switched off/);
  await assert.rejects(app.registry.execute("browser.act", { action: "click", mark: 1 }, run), /switched off/);
  await app.registry.execute("browser.act", { action: "fill", name: "Name", value: "ok" }, run);
  // Every other step that finds a thing by its number refuses too.
  if (app.registry.names().includes("browser.hover")) await assert.rejects(app.registry.execute("browser.hover", { mark: 1 }, run), /switched off/);
});

test("Downloads from known sites only: a file from the page's own site is kept, one from another site is not", async (t) => {
  const { app, origin, context } = await fixture(t, { downloadsFrom: "known" });
  const run = context();
  await app.registry.execute("browser.navigate", { url: `${origin}/` }, run);
  const here = await app.registry.execute("browser.act", { action: "click", selector: "#here" }, run);
  assert.equal(here.downloads?.[0]?.file, "downloads/here.txt", JSON.stringify(here));
  const there = await app.registry.execute("browser.act", { action: "click", selector: "#there" }, run);
  assert.match(there.downloads?.[0]?.from ?? "", /not saved: .*downloads may come only from sites/, JSON.stringify(there));
});

test("Record browser tasks: every task that opens a page keeps a recording when it ends", async (t) => {
  const { app, browser, origin, context, root } = await fixture(t, { recordTasks: true });
  const run = context();
  await app.registry.execute("browser.navigate", { url: `${origin}/` }, run);
  await browser.closeRun(run);
  const kept = await readdir(join(app.artifacts.root, run.runId));
  assert.ok(kept.some((name) => /^browser-recording-.*\.zip$/.test(name)), JSON.stringify(kept));
});

test("Record browser tasks: taking the window over keeps the recording first, so the owner can type in it", async (t) => {
  const { app, browser, origin, context } = await fixture(t, { recordTasks: true });
  const sessionId = app.store.createSession(app.runtime.owner);
  const run = context(app.store.createRun(app.runtime.owner, "Task", sessionId, false, "window").id);
  await app.registry.execute("browser.navigate", { url: `${origin}/` }, run);
  const entry = () => [...browser.sessions.values()].find((one) => one.session.started());
  assert.equal(entry().session.isRecording(), true);
  const control = await browser.adoptRun(app.runtime.owner, sessionId, run.runId, "window");
  assert.equal(entry().session.isRecording(), false, "kept before the owner drives");
  assert.equal(control.view().tabs.length, 1);
});
