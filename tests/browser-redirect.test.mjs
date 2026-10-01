import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { BranchBrowser, redirectHops } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget } from "../dist/index.js";

/**
 * A redirect to a website the owner allowed is followed; one to anywhere else is still not.
 *
 * Refusing every redirect looked safe and broke the ordinary way of signing in: the form is answered
 * with "now go here", and Branch landed on a browser error page instead of the page it had just signed
 * in to. The existing test — "an allowed site cannot redirect the browser to an unlisted origin" —
 * passed either way, because it only checks that the forbidden website was never fetched. So nothing
 * went red while the guard was far stricter than it meant to be.
 *
 * Local only: two small servers on 127.0.0.1 and a headless browser.
 */

const context = (permissions = ["browser.read", "browser.interact"]) => ({
  owner: "test", workspace: ".", runId: "redirect", signal: AbortSignal.timeout(60000),
  budget: new Budget(), permissions: new Set(permissions), depth: 0,
});

/* Cleanup hooks run in registration order, so these fixture servers close before the browser.
   A service worker may retain an active connection indefinitely. Stop accepting connections, then
   close only this disposable server's connections so cleanup cannot wait on a later browser hook. */
async function closeFixture(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

/** A site that signs a member in with a redirect, the way nearly every site does. */
async function siteThatRedirects() {
  const asked = [];
  const sessions = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const signedIn = /(?:^|;\s*)sid=in\b/.test(request.headers.cookie ?? "");
    asked.push({ path: url.pathname, signedIn });
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><body><h1>Way in</h1><form method="GET" action="/enter"><button type="submit">Sign in</button></form>');
      return;
    }
    if (url.pathname === "/enter") {
      sessions.add("in");
      response.writeHead(302, { "set-cookie": "sid=in; Path=/", location: "/desk" });
      response.end();
      return;
    }
    if (url.pathname === "/desk") {
      response.writeHead(signedIn ? 200 : 401, { "content-type": "text/html" });
      response.end(`<!doctype html><body><h1>${signedIn ? "Signed in at the desk" : "Please sign in"}</h1>`);
      return;
    }
    if (url.pathname.startsWith("/round")) { // a site that never stops sending the browser onwards
      const at = Number(url.pathname.slice("/round".length) || "0");
      response.writeHead(302, { location: `/round${at + 1}` });
      response.end();
      return;
    }
    response.writeHead(404).end("no");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`, asked,
    close: async () => { await closeFixture(server); },
  };
}

test("signing in works: the redirect the site answers with is followed, and the session survives it", async (t) => {
  const site = await siteThatRedirects();
  t.after(() => site.close());
  const browser = new BranchBrowser({ allowedOrigins: [site.origin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);

  await registry.execute("browser.navigate", { url: site.origin }, context());
  await registry.execute("browser.click", { role: "button", name: "Sign in" }, context());
  const page = await registry.execute("browser.snapshot", {}, context());

  assert.match(page.accessibility, /Signed in at the desk/, "it landed on the page it signed in to");
  assert.ok(site.asked.some((one) => one.path === "/desk" && one.signedIn),
    "and the desk was fetched with the session the redirect handed out");
});

test("a redirect to a website the owner did not allow is still refused, and never fetched", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((_request, response) => { response.writeHead(302, { location: elsewhere }); response.end(); });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const origin = `http://127.0.0.1:${allowed.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  t.after(() => browser.close());
  await assert.rejects(browser.navigate(origin, context(["browser.read"])));
  assert.equal(forbiddenHits, 0, "the website that was not allowed was never asked for anything");
});

test("the network policy checks the redirect destination before it is fetched", async (t) => {
  let destinationHits = 0;
  const destination = createServer((_request, response) => { destinationHits += 1; response.end("must not load"); });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  t.after(async () => { await closeFixture(destination); });
  const destinationOrigin = `http://127.0.0.1:${destination.address().port}`;

  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `${destinationOrigin}/private` });
    response.end();
  });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  t.after(async () => { await closeFixture(source); });
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  const checked = [];
  const browser = new BranchBrowser({ allowedOrigins: [sourceOrigin, destinationOrigin] });
  browser.policy = { assertAllowed: async (target) => {
    checked.push(target.href);
    if (target.origin === destinationOrigin) throw new Error("blocked by the owner's network rules");
  } };
  t.after(() => browser.close());

  await assert.rejects(browser.navigate(`${sourceOrigin}/start`, context(["browser.read"])));
  // browser.navigate checks before opening a window; Chromium's actual first request is then checked by both the
  // route and the pause (the route's check once missed pages entirely, comparing 'document' with 'Document');
  // then the redirect hop is checked before it is sent, and last.
  assert.equal(checked.filter((href) => href === `${sourceOrigin}/start`).length, 3, checked.join(" "));
  assert.deepEqual(checked.filter((href) => href !== `${sourceOrigin}/start`), [`${destinationOrigin}/private`]);
  assert.equal(checked.at(-1), `${destinationOrigin}/private`);
  assert.equal(destinationHits, 0, "the destination was refused before a request reached it");
});

test("a pop-up cannot send its first request to an unlisted website", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<button onclick="window.open('${forbiddenOrigin}/stolen')">Open report</button>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const allowedOrigin = `http://127.0.0.1:${allowed.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [allowedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);

  await registry.execute("browser.navigate", { url: allowedOrigin }, context());
  await registry.execute("browser.click", { role: "button", name: "Open report" }, context());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(forbiddenHits, 0, "the pop-up was refused before its first request left Chromium");
});


test("being sent to a website costs the task the same as going there by name", async (t) => {
  // How many different websites one task may visit was charged only where an address is typed.
  // Going straight to a second website was refused; being *sent* there by a redirect was not, so a
  // chain of them could walk a task across every website the owner allowed for the price of one.
  let secondHits = 0;
  const second = createServer((_request, response) => {
    secondHits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>The second place</h1>");
  });
  second.listen(0, "127.0.0.1");
  await once(second, "listening");
  t.after(async () => { await closeFixture(second); });
  const elsewhere = `http://127.0.0.1:${second.address().port}`;

  const first = createServer((request, response) => {
    if ((request.url ?? "/") === "/away") { response.writeHead(302, { location: elsewhere }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>The first place</h1>");
  });
  first.listen(0, "127.0.0.1");
  await once(first, "listening");
  t.after(async () => { await closeFixture(first); });
  const origin = `http://127.0.0.1:${first.address().port}`;

  // Both websites are allowed. What is limited is how many of them one task may visit.
  const browser = new BranchBrowser({ allowedOrigins: [origin, elsewhere], maxOriginsPerRun: 1 });
  t.after(() => browser.close());

  await browser.navigate(origin, context(["browser.read"]));
  await assert.rejects(browser.navigate(elsewhere, context(["browser.read"])),
    /already opened 1 different websites/, "going there by name is refused, as it always was");

  // The same website, reached by being sent to it. It has to cost the same.
  await browser.navigate(`${origin}/away`, context(["browser.read"])).catch(() => undefined);
  assert.equal(secondHits, 0, "the second website was never asked for anything");
});


test("a pop-up cannot be redirected to an unlisted website either", async (t) => {
  // The existing test above proves a pop-up's *first* request is checked. What it could not see is
  // what happens when that first request is to a website the owner allowed and the answer is "now go
  // here": the hops after it are Chromium's own, and the pause that watches those is attached only
  // to tabs Branch opened. Measured before the fix, the unlisted website really served the page.
  //
  // Attaching the pause to the pop-up as well does not close it: the first request and its redirect
  // are in flight before the pause can be enabled. A tab the website opened by itself is going to be
  // closed anyway, so until it is, it is answered with nothing at all.
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => {
    forbiddenHits += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><body><h1>must not load</h1>");
  });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;

  const allowed = createServer((request, response) => {
    if ((request.url ?? "/") === "/hop") { response.writeHead(302, { location: `${elsewhere}/taken` }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><body><a id="go" href="/hop" target="_blank">open</a>`
      + `<script>document.getElementById("go").click()</script>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const origin = `http://127.0.0.1:${allowed.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  t.after(() => browser.close());
  await browser.navigate(origin, context(["browser.read"]));
  // The pop-up opens, asks, and is closed. Long enough that a request in flight would have landed.
  await new Promise((resolve) => { setTimeout(resolve, 2500); });

  assert.equal(forbiddenHits, 0, "the website that was not allowed was never asked for anything");
});

test("a site that keeps sending the browser onwards is given up on", async (t) => {
  const site = await siteThatRedirects();
  t.after(() => site.close());
  const browser = new BranchBrowser({ allowedOrigins: [site.origin] });
  t.after(() => browser.close());

  await assert.rejects(browser.navigate(`${site.origin}/round0`, context(["browser.read"])),
    "a round of redirects ends in a refusal rather than going on for ever");
  const rounds = site.asked.filter((one) => one.path.startsWith("/round"));
  // A fixed number on purpose: measuring against the product's own constant would move with it, and
  // then loosening the limit would still pass.
  assert.ok(rounds.length <= 8, `it stopped after a few (${rounds.length})`);
  assert.ok(redirectHops <= 5, `and the limit itself stays small (${redirectHops})`);
});

/**
 * A frame an allowed page shows cannot be sent to a website the owner did not allow, whether its own request or
 * its own navigation is redirected. In Branch's own window such a frame shares the page's process (measured), so
 * this holds by the pause; the owner's Chrome, where it does not, is asked the same in tests/browser-2.test.mjs.
 */
test("a frame from another allowed website cannot be redirected to an unlisted one", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;

  const framedAsked = [];
  const framed = createServer((request, response) => {
    framedAsked.push(request.url);
    if (request.url === "/f") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><script>fetch("/r").catch(() => {}); setTimeout(() => { location = "/r2"; }, 300);</script>`);
      return;
    }
    response.writeHead(302, { location: `${forbiddenOrigin}/stolen` });
    response.end();
  });
  framed.listen(0, "127.0.0.1");
  await once(framed, "listening");
  t.after(async () => { await closeFixture(framed); });
  // Another website: a different host name is a different site, so Chromium puts its frame in its own process.
  const framedOrigin = `http://localhost:${framed.address().port}`;

  const page = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><h1>Report</h1><iframe src="${framedOrigin}/f"></iframe>`);
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  t.after(async () => { await closeFixture(page); });
  const pageOrigin = `http://127.0.0.1:${page.address().port}`;

  const browser = new BranchBrowser({ allowedOrigins: [pageOrigin, framedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);
  await registry.execute("browser.navigate", { url: pageOrigin }, context());
  for (let waited = 0; waited < 40 && !(framedAsked.includes("/r") && framedAsked.includes("/r2")); waited++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(framedAsked.includes("/r") && framedAsked.includes("/r2"), `the frame really asked: ${framedAsked.join(" ")}`);
  assert.equal(forbiddenHits, 0, "neither the frame's fetch nor its own navigation was sent onwards");
});

/* A worker shared between pages sends its requests where neither the route nor the pause sees them, and
   serviceWorkers: 'block' does not cover it (Mac mini 0361600 measured it fetching an unlisted website). */
test("a page in Branch's own window cannot start a shared worker that fetches an unlisted website", async (t) => {
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;
  const allowed = createServer((request, response) => {
    if (request.url.startsWith("/wk.js")) {
      response.setHeader("content-type", "text/javascript");
      response.end(`fetch(${JSON.stringify(`${forbiddenOrigin}/from-shared-worker`)}).catch(() => {});`);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>start</title><script>try { new SharedWorker("/wk.js"); document.title = "started"; } catch { document.title = "refused"; }</script>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const allowedOrigin = `http://127.0.0.1:${allowed.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [allowedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);
  await registry.execute("browser.navigate", { url: allowedOrigin }, context());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(forbiddenHits, 0, "the unlisted website was never asked");
});

test("a page in Branch's own window cannot start a service worker round the block to fetch an unlisted website", async (t) => {
  const hits = [];
  const forbidden = createServer((request, response) => { hits.push(request.url); response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;
  const allowed = createServer((request, response) => {
    if (request.url.startsWith("/sw.js")) {
      // A worker that fetches the unlisted website as soon as it installs, and again whenever it is asked to.
      response.setHeader("content-type", "text/javascript");
      response.end(`self.addEventListener("install", (event) => { self.skipWaiting(); event.waitUntil(fetch(${JSON.stringify(`${forbiddenOrigin}/on-install`)}).catch(() => {})); });
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));
self.addEventListener("message", (event) => { fetch(event.data).catch(() => {}); });`);
      return;
    }
    // Round the block: the prototype's own method, and the page's copy deleted.
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>start</title><script>
const to = ${JSON.stringify(`${forbiddenOrigin}/on-message`)}, said = [];
const go = async (how, register) => { try { await register(); await navigator.serviceWorker.ready;
  (await navigator.serviceWorker.getRegistration()).active?.postMessage(to); said.push(how + " registered"); } catch { said.push(how + " refused"); }
  document.title = said.join(", "); };
go("prototype", () => ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "/sw.js?1"));
try { delete navigator.serviceWorker.register; } catch {}
go("deleted", () => navigator.serviceWorker.register("/sw.js?2"));
</script>`);
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const allowedOrigin = `http://127.0.0.1:${allowed.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [allowedOrigin] });
  t.after(() => browser.close());
  const registry = new ToolRegistry();
  const { registerBrowser } = await import("../dist/integrations/browser.js");
  registerBrowser(registry, browser);
  await registry.execute("browser.navigate", { url: allowedOrigin }, context());
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.deepEqual(hits, [], "the unlisted website was never asked, by a worker started either way");
});

test("in the owner's browser, a service worker their own browsing registered cannot fetch an unlisted website for Branch's tab", async (t) => {
  const { chromium } = await import("playwright");
  const { BrowserSession } = await import("../dist/integrations/browser-session.js");
  const hits = [];
  const forbidden = createServer((request, response) => { hits.push(request.url); response.setHeader("access-control-allow-origin", "*"); response.end("must not load"); });
  forbidden.listen(0, "127.0.0.1");
  await once(forbidden, "listening");
  t.after(async () => { await closeFixture(forbidden); });
  const forbiddenOrigin = `http://127.0.0.1:${forbidden.address().port}`;
  // The owner's own site, whose worker passes every request of the pages it controls on, as many real ones do.
  const allowed = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(`self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));`);
      return;
    }
    response.setHeader("content-type", "text/html");
    // A frame's page that says whether a worker runs it and what its fetch got, then fetches and loads an image.
    if (request.url.startsWith("/frame")) {
      const tag = new URL(request.url, allowedOrigin).searchParams.get("tag");
      response.end(`<!doctype html><script>fetch(${JSON.stringify(`${forbiddenOrigin}/frame-fetch-`)} + ${JSON.stringify(tag)})
  .then((r) => r.status, () => "refused").then((got) => top.postMessage({ tag: ${JSON.stringify(tag)}, controlled: !!navigator.serviceWorker.controller, got }, "*"));
new Image().src = ${JSON.stringify(`${forbiddenOrigin}/frame-image-`)} + ${JSON.stringify(tag)};</script>`);
      return;
    }
    // The frame's next page: by then a frame from another website is a target of its own.
    if (request.url.startsWith("/hop")) {
      response.end(`<!doctype html><script>location.href = "/frame" + location.search;</script>`);
      return;
    }
    response.end("<!doctype html><title>allowed</title>");
  });
  allowed.listen(0, "127.0.0.1");
  await once(allowed, "listening");
  t.after(async () => { await closeFixture(allowed); });
  const allowedOrigin = `http://127.0.0.1:${allowed.address().port}`;
  // Started the way Chrome starts, with each website in a process of its own, as the owner's browser is.
  const browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  t.after(() => browser.close());
  const owners = await browser.newContext();
  // Before the task, the owner visits the allowed site, which registers its worker.
  const theirs = await owners.newPage();
  await theirs.goto(allowedOrigin);
  await theirs.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
  await theirs.reload();
  assert.equal(await theirs.evaluate(() => !!navigator.serviceWorker.controller), true, "the owner's worker is running");
  const session = new BrowserSession(async () => browser, async () => undefined);
  session.options = { attached: { context: owners, detach: async () => undefined },
    guardUrl: (url) => (url.startsWith(forbiddenOrigin) ? "not on the website list" : null) };
  const task = () => ({ owner: "test", runId: "sw", signal: AbortSignal.timeout(60000) });
  await session.use(task(), async (page) => { await page.goto(allowedOrigin); await page.reload(); });
  assert.equal(await session.use(task(), (page) => page.evaluate(() => !!navigator.serviceWorker.controller)), false,
    "Branch's tab is not run by the owner's worker");
  const fetched = await session.use(task(), (page) => page.evaluate((url) => fetch(url).then((r) => r.status, () => "refused"), `${forbiddenOrigin}/fetch`));
  await session.use(task(), (page) => page.evaluate((url) => { const image = new Image(); image.src = url; document.body.append(image); }, `${forbiddenOrigin}/image`));
  // Pages on other websites that frame the owner's site: localhost, [::1] and 127.0.0.1 are three sites, so each
  // frame is a process and a target of its own. The frame is in Branch's tab and skips the owner's worker too: on
  // its first page, on its next one, and inside a frame from yet another website (NAS 6d8c1b1).
  const framer = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    const src = new URL(request.url, "http://localhost").searchParams.get("src");
    response.end(`<!doctype html><script>window.said = []; addEventListener("message", (event) => said.push(event.data));</script><iframe src="${src}"></iframe>`);
  });
  framer.listen(0, "::");
  await once(framer, "listening");
  t.after(async () => { await closeFixture(framer); });
  const framing = (host, src) => `http://${host}:${framer.address().port}/?src=${encodeURIComponent(src)}`;
  const cases = {
    first: framing("localhost", `${allowedOrigin}/frame?tag=first`),
    next: framing("localhost", `${allowedOrigin}/hop?tag=next`),
    nested: framing("localhost", framing("[::1]", `${allowedOrigin}/hop?tag=nested`)),
  };
  for (const [tag, url] of Object.entries(cases)) {
    const said = await session.use(task(), async (page) => {
      await page.goto(url);
      await page.waitForFunction(() => window.said.length > 0, undefined, { timeout: 10000 });
      assert.ok(page.frames().some((frame) => frame.url() === `${allowedOrigin}/frame?tag=${tag}`), `${tag}: the owner's site is framed`);
      return page.evaluate(() => window.said);
    });
    assert.deepEqual(said, [{ tag, controlled: false, got: "refused" }], `${tag}: no worker runs the frame, and its fetch is refused`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(fetched, "refused");
  assert.deepEqual(hits, [], "the unlisted website was never asked, from the page or from the frame");
  // The owner's own tab is theirs as it was: their worker still runs it and still reaches the website for them.
  assert.equal(await theirs.evaluate(() => !!navigator.serviceWorker.controller), true, "the owner's tab still has its worker");
  assert.equal(await theirs.evaluate((url) => fetch(url).then((r) => r.status), `${forbiddenOrigin}/theirs`), 200);
  assert.deepEqual(hits, ["/theirs"]);
});
