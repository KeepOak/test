/**
 * SELF-312: web search, page reading and the real browser are available to the lead and to its helpers. The lead is
 * the default Trunk in Full Access; its helper is a background task it starts with its own tools. Each searches the
 * web (the free search, pointed at a local stand-in that answers in its format), reads the page it found, and opens that
 * page in Branch's real browser (a headless Chromium) and reads it there. Nothing leaves this computer; no question is
 * asked in Full Access. Scripted model, isolated engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";

const PAGE = "<!doctype html><title>Oak facts</title><h1>Oak facts</h1><p>SELF-312 proof: oaks can live a thousand years.</p>";
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const wanted = ["web.search", "web.fetch", "browser.navigate", "browser.snapshot"];

// It drives Chromium through Branch's own browser tool; the import above is what the test selector reads to give this
// lane a browser (tests/browser-tests-declared.test.mjs), and this asserts it is really there.
test("this test needs a real browser, and says so", () => {
  assert.equal(chromium.name(), "chromium", "this test declares the browser engine it requires");
});

test("the lead and a helper it starts each search the web, read a page and use the real browser", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-lead-web-"));
  const site = createServer((request, response) => {
    if (request.url?.startsWith("/lite")) {
      const link = `http://127.0.0.1:${site.address().port}/oaks`;
      response.writeHead(200, { "content-type": "text/html" }).end(`<table><tr><td><a rel="nofollow" href="${link}" class='result-link'>Oak facts</a></td></tr><tr><td class='result-snippet'>How long oaks live.</td></tr></table>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  // Each task, the lead's and the helper's, opens the web and browser boxes, then searches, reads and browses.
  const steps = (found) => [
    (tools) => (wanted.every((name) => tools.includes(name)) ? null
      : call("tools.expand", { groups: [...new Set(wanted.map((name) => groups[name]))] })),
    () => call("web.search", { query: "how long do oaks live" }),
    () => call("web.fetch", { url: `${origin}/oaks` }),
    () => call("browser.navigate", { url: `${origin}/oaks` }),
    () => call("browser.snapshot", {}),
    () => found(),
  ];
  const groups = {};
  const provider = { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const helper = /HELPER-312/.test(system);
    const done = request.messages.filter((m) => m.role === "tool").length;
    const tools = request.tools.map((tool) => tool.name);
    const plan = steps(() => ({ content: helper ? "Helper: oaks live a thousand years." : "Lead: oaks live a thousand years.", toolCalls: [] }));
    // The first step opens the boxes only when they are closed; the others follow in turn.
    const opened = request.messages.some((m) => m.role === "tool" && /"opened"/.test(m.content));
    const at = done - (opened ? 1 : 0);
    if (at === 0 && !opened) { const open = plan[0](tools); if (open) return open; }
    return plan[at + 1]?.() ?? plan.at(-1)();
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
    web: { allowPrivateAddresses: true, searchEndpoint: `${origin}/lite/` } });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  for (const name of wanted) groups[name] = app.registry.groupOf(name);
  t.after(async () => { await browser.close(); await app.close(); site.close(); await discardTemp(root); });

  const home = app.trunks.ensureDefault(true);
  const lead = await app.runtime.run({ prompt: "Find out how long oaks live", trunkId: home.id, mode: "full" });
  assert.equal(lead.status, "completed", lead.output);
  assert.equal(lead.output, "Lead: oaks live a thousand years.");
  const ran = (runId) => app.store.events(runId).filter((e) => e.kind === "tool.completed").map((e) => e.data.name);
  const said = (runId, name) => JSON.stringify(app.store.events(runId).find((e) => e.kind === "tool.completed" && e.data.name === name)?.data.result ?? null);
  /** What each tool really came back with: the search found the page, the read got it, the browser showed it. */
  const proven = (runId, who) => {
    assert.match(said(runId, "web.search"), /Oak facts.*\/oaks/, `${who}: the search found the page`);
    assert.match(said(runId, "web.fetch"), /\/oaks/, `${who}: the page was read`);
    assert.match(said(runId, "browser.navigate"), /"title":"Oak facts"/, `${who}: the real browser opened it`);
    assert.match(said(runId, "browser.snapshot"), /SELF-312 proof: oaks can live a thousand years/, `${who}: and read it there`);
  };
  for (const name of wanted) assert.ok(ran(lead.id).includes(name), `the lead ran ${name}: ${JSON.stringify(ran(lead.id))}`);
  assert.equal(app.store.events(lead.id).filter((e) => /approval|needs_input/.test(e.kind)).length, 0, "no question in Full Access");
  proven(lead.id, "lead");

  // A helper the lead starts, with the lead's own tools, does the same in the background.
  const context = app.runtime.context({ runId: lead.id });
  const started = await app.runtime.delegateBackground("Check how long oaks live. HELPER-312", context, [...context.permissions],
    "You are a helper working in the background. HELPER-312", { timeoutMs: 110_000 });
  let helperRun;
  for (let i = 0; i < 600 && !["completed", "failed", "cancelled"].includes((helperRun = app.store.run(started.childRunId))?.status); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(helperRun.status, "completed", helperRun.output);
  assert.equal(helperRun.output, "Helper: oaks live a thousand years.");
  for (const name of wanted) assert.ok(ran(helperRun.id).includes(name), `the helper ran ${name}: ${JSON.stringify(ran(helperRun.id))}`);
  proven(helperRun.id, "helper");
});
