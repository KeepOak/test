/* The owner typed keepoak.com into "Trunk 1's browser" in the desktop app and was told "There is no tool called
   browser.navigate.": with no launch settings file (the desktop's default) the browser tools were never registered.
   Branch's browser now ships on. These tests build the engine the way src/desktop/engine-process.ts does
   (createBranch, then loadIntegrations with no file, then startServer) and prove the owner's address opens and shows. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { Budget, createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { BranchBrowser } from "../dist/integrations/browser.js";
import { randomUUID } from "node:crypto";

assert.equal(typeof chromium.launch, "function");

async function site(t, pages) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    const page = pages[request.url?.split("?")[0] ?? "/"] ?? "<title>Missing</title>";
    response.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

/* The desktop engine with no launch file, a Trunk, and a conversation of that Trunk's that has finished its turn. The
   owner's address goes through the window's own routes: /api/panels/browser/start, then /action with browser.navigate
   (the address bar turns a site's name into https:// and words into a search before it asks). */
async function engine(t, web = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-default-browser-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, web });
  const integrations = await loadIntegrations(app.registry, undefined, process.env, app.secretsFor, app.channelHost);
  app.browser = integrations.hosted.browser ?? null;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await integrations.close(); await app.close(); await discardTemp(root); });
  app.trunks.setMode("trunks", { mode: "on" });
  const trunk = app.trunks.create({ name: "Trunk 1" });
  await app.trunks.introduced();
  const said = await app.trunks.say(trunk.id, "hello");
  assert.equal(said.status, "completed", JSON.stringify(said));
  const sessionId = app.store.run(said.runId).sessionId;
  assert.equal(sessionId, trunk.chatSessionId, "Trunk 1's own conversation");
  const scope = { sessionId, clientId: randomUUID(), profile: null };
  const call = async (part, body, method = "POST") => {
    const url = new URL(`/api/panels/browser${part}`, server.url);
    if (method === "GET") for (const [key, value] of Object.entries(body)) if (value !== null) url.searchParams.set(key, String(value));
    const answer = await fetch(url, { method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    assert.equal(answer.status, 200, await answer.clone().text());
    return answer.json();
  };
  /* Allow once, as the window asks the owner, when the owner's rules ask first. */
  const answered = async (part, body) => { const first = await call(part, body); return first.status === "asked" ? call(part, { ...body, confirmToken: first.confirmToken }) : first; };
  let control = null;
  const view = () => call("", { ...scope, id: control.id, epoch: control.epoch }, "GET");
  const browse = async (url) => {
    if (!control) { const started = await answered("/start", scope); assert.equal(started.status, "ready", JSON.stringify(started)); control = started.control; }
    const seen = await view(); control = seen.control;
    const outcome = await answered("/action", { ...scope, id: control.id, epoch: control.epoch, frameId: seen.frameId, tabId: seen.tabId,
      sequence: control.sequence + 1, tool: "browser.navigate", arguments: { url } });
    control = outcome.control ?? control;
    return outcome;
  };
  return { app, sessionId, browse, view, call, scope, control: () => control };
}

test("with no launch file, the owner's address opens in Branch's browser and the live view shows the page", async (t) => {
  const { origin } = await site(t, { "/": "<title>Keep Oak fixture</title><h1>Keep Oak</h1>" });
  const { app, browse, view, call, scope } = await engine(t, { allowPrivateAddresses: true });
  assert.ok(app.registry.names().includes("browser.navigate"), "the browser ships on");
  assert.equal((await call("", scope, "GET")).status, "none", "before: nothing open");
  const outcome = await browse(`${origin}/`);
  assert.doesNotMatch(JSON.stringify(outcome), /There is no tool called/);
  assert.equal(outcome.status, "ran", JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.result.title, "Keep Oak fixture");
  // What the window's browser view actually reads (GET /api/panels/browser), not the empty state.
  const seen = await view();
  assert.equal(seen.page.title, "Keep Oak fixture", "the view shows the page");
  assert.equal(seen.page.url, `${origin}/`);
  assert.equal(seen.page.tabs.length, 1);
  assert.equal(seen.ready, true);
  assert.ok(seen.page.frame, "with a picture of it");
  assert.equal((await call("", scope, "GET")).status, "found", "a window that reopens finds the conversation's browser again");
});

test("with no launch file, the owner's typing still meets the network rules: this computer's own address is refused by them", async (t) => {
  const { browse } = await engine(t);
  const outcome = await browse("http://127.0.0.1:9/");
  assert.equal(outcome.status, "failed", JSON.stringify(outcome).slice(0, 300));
  assert.match(outcome.error, /points at this computer or a private network|private/i);
});

test("the owner's browser outlives the per-task limit on websites: every address the owner opens is its own step", async (t) => {
  const pages = {};
  for (let i = 0; i < 7; i++) pages[`/${i}`] = `<title>Site ${i}</title>`;
  const sites = [];
  for (let i = 0; i < 7; i++) sites.push(await site(t, pages)); // seven different origins, more than one task may open
  const { browse } = await engine(t, { allowPrivateAddresses: true });
  for (let i = 0; i < 7; i++) {
    const outcome = await browse(`${sites[i].origin}/${i}`);
    assert.equal(outcome.status, "ran", `site ${i}: ${JSON.stringify(outcome).slice(0, 300)}`);
    assert.equal(outcome.result.title, `Site ${i}`);
  }
});

test("any-website mode checks every request a page makes, not only the page itself, against the network rules", async (t) => {
  const inside = await site(t, { "/secret": "secret" });
  const page = await site(t, { "/": `<title>Outside</title><img src="${inside.origin}/secret?img"><script>fetch("${inside.origin}/secret?fetch").catch(() => {})</script>` });
  const browser = new BranchBrowser({ anyWebsite: true });
  const pagePort = new URL(page.origin).port;
  browser.policy = { async assertAllowed(target) { if (target.port !== pagePort) throw new Error(`${target.host} points at this computer or a private network`); },
    async allowedAddresses(target) { await this.assertAllowed(target); return null; } };
  t.after(() => browser.close());
  const context = { owner: "owner-1", workspace: ".", runId: "any-website", signal: new AbortController().signal, budget: new Budget(),
    permissions: new Set(["browser.read"]), depth: 0 };
  const opened = await browser.navigate(`${page.origin}/`, context);
  assert.equal(opened.title, "Outside");
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(inside.hits, [], "the private address was never reached by the page's picture or script");
});

test("any-website mode without network rules refuses rather than opening anything", async (t) => {
  const browser = new BranchBrowser({ anyWebsite: true });
  t.after(() => browser.close());
  const context = { owner: "owner-1", workspace: ".", runId: "no-rules", signal: new AbortController().signal, budget: new Budget(),
    permissions: new Set(["browser.read"]), depth: 0 };
  await assert.rejects(browser.navigate("https://example.org/", context), /network rules/);
});

test("a launch file's browser section is either a list of websites or any website, never both or neither", () => {
  assert.throws(() => new BranchBrowser({ anyWebsite: true, allowedOrigins: ["https://example.org"] }));
  assert.throws(() => new BranchBrowser({}));
  assert.doesNotThrow(() => new BranchBrowser({ allowedOrigins: ["https://example.org"] }));
});
