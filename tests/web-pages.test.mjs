/**
 * w911 (A0743, A1452): reading one web page (plain route or Branch's own headless browser) and
 * following one site's own links. Every page comes from a server this file starts on the loopback
 * address; no real website is opened. The app allows private addresses the same way other tests do
 * (web.allowPrivateAddresses), and "localhost" is put on the blocked list so a refused host exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, saveWebPagesSettings, webPagesOff } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { robotsRules } from "../dist/web-robots.js";
import { fetchChecked } from "../dist/web-page-fetch.js";
import { pinnedFetch, pinnedTo } from "../dist/pinned-fetch.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function served(t, provider = quiet) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-pages-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
    web: { allowPrivateAddresses: true, blockedHosts: ["localhost"] } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await server.close(); await app.close(); await discardTemp(root);
  });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const on = () => saveWebPagesSettings(app.store, app.runtime.owner, { mode: "when-needed", crawlDelayMs: 400 });
  const tool = (name, args) => app.runtime.executeTool(name, args, { mode: "owner" });
  return { app, call, on, tool, closers };
}

const html = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const prose = (words) => `<p>${"The survey team measured the tower again this spring and wrote it all down. ".repeat(words)}</p>`;

/** A local site. Each route is [status, type, body, headers?]; every request is counted by path. */
async function site(t, routes) {
  const hits = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const route = routes[url.pathname];
    const [status, type, body, headers] = typeof route === "function" ? route(base) : route ?? [404, "text/plain", "not here"];
    response.writeHead(status, { "content-type": type, ...(headers ?? {}) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base, port: server.address().port, hits: (path) => hits.get(path) ?? 0, total: () => [...hits.values()].reduce((a, b) => a + b, 0) };
}

const cloudflare503 = [503, "text/html", html("Just a moment...", `<div id="cf-chl-widget">Checking your browser before accessing the site.</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>`)];

/** Stand-in browser tools that only count, to prove a route did not open the browser. */
function countingBrowser(app) {
  const opened = [];
  app.registry.register({ name: "browser.navigate", permission: "browser.read", description: "stand-in",
    parameters: z.object({ url: z.string() }).strict(), execute: async ({ url }) => { opened.push(url); return { url, title: "stand-in" }; } });
  app.registry.register({ name: "browser.snapshot", permission: "browser.read", description: "stand-in",
    parameters: z.object({}).strict(), execute: async () => ({ url: opened.at(-1), accessibility: "- paragraph: stand-in" }) });
  return opened;
}

const manualRun = (app, tool) => app.store.runs(app.runtime.owner).find((run) => run.prompt === `Manual action: ${tool}`);

/* ---------- the switch ---------- */

test("A0743 A1452: the web-pages switch ships when needed; off refuses in one sentence and hides both tools; the owner route turns it on", async (t) => {
  const { app, call, tool } = await served(t);
  const owner = app.runtime.owner, names = ["web.page", "web.crawl"];
  const tiers = () => switchedToolTiers(app.store, owner, app.registry.names());
  // The ship-on rule: reading whole pages ships "when needed" (src/web-pages-settings.ts); the owner switches it off.
  assert.equal((await call("/api/web-pages")).body.settings.mode, "when-needed");
  assert.equal((await call("/api/web-pages", { mode: "off" })).body.settings.mode, "off");
  assert.deepEqual(tiers().hidden.filter((name) => names.includes(name)).sort(), [...names].sort());
  for (const name of names)
    await assert.rejects(tool(name, { url: "http://127.0.0.1:9/" }), (error) => error.message === webPagesOff);
  assert.equal(webPagesOff.split(/[.!?](\s|$)/).filter((part) => part && part.trim()).length, 1, "one sentence");

  const tools = (await call("/api/tools")).body.tools.map((entry) => entry.name);
  for (const name of names) assert.equal(tools.filter((entry) => entry === name).length, 1, `${name} listed once`);
  assert.equal(new Set(app.registry.names()).size, app.registry.names().length, "no duplicate tool names");

  assert.equal((await call("/api/web-pages", { mode: "loud" })).status, 400);
  assert.equal((await call("/api/web-pages", { crawlDelayMs: 5 })).status, 400);
  assert.equal((await call("/api/web-pages", { mode: "on" })).body.settings.mode, "on");
  const listedOn = (await call("/api/tools")).body.tools.map((entry) => entry.name);
  for (const name of names) assert.equal(listedOn.filter((entry) => entry === name).length, 1, `${name} listed once while on`);
  assert.deepEqual(tiers().preload.filter((entry) => names.includes(entry.name)).map((entry) => entry.name).sort(), [...names].sort());
  assert.equal((await call("/api/web-pages", { mode: "when-needed" })).body.settings.mode, "when-needed");
  assert.ok(!tiers().hidden.includes("web.page") && !tiers().preload.some((entry) => entry.name === "web.page"));
});

/* ---------- web.page ---------- */

test("A0743: the plain route reads a page, follows allowed redirects, and says which route it used", async (t) => {
  const { on, tool } = await served(t);
  const local = await site(t, {
    "/article": [200, "text/html; charset=utf-8", html("Tower", prose(20))],
    "/r1": [302, "text/plain", "", { location: "/r2" }],
    "/r2": [301, "text/plain", "", { location: "/article" }],
    "/picture": [200, "image/png", "PNG"],
  });
  on();
  const page = await tool("web.page", { url: `${local.base}/r1`, maxChars: 500 });
  assert.equal(page.challenged, false);
  assert.equal(page.route, "plain");
  assert.equal(page.url, `${local.base}/article`);
  assert.equal(page.title, "Tower");
  assert.equal(page.text.length, 500);
  assert.ok(page.droppedChars > 0, "the dropped characters are counted");
  assert.equal(page.provenance.trust, "untrusted");
  await assert.rejects(tool("web.page", { url: `${local.base}/picture` }), /not a readable page/);
  await assert.rejects(tool("web.page", { url: `${local.base}/missing` }), /HTTP 404/);
});

test("A0743: every redirect hop is checked, so a redirect to a refused host is refused before any request reaches it", async (t) => {
  const { on, tool } = await served(t);
  const refused = await site(t, { "/secret": [200, "text/html", html("Secret", prose(5))] });
  const local = await site(t, { "/hop": () => [302, "text/plain", "", { location: `http://localhost:${refused.port}/secret` }] });
  on();
  await assert.rejects(tool("web.page", { url: `${local.base}/hop`, route: "plain" }), /localhost is on the blocked list/);
  await assert.rejects(tool("web.page", { url: `http://localhost:${refused.port}/secret` }), /blocked list/);
  assert.equal(local.hits("/hop"), 1);
  assert.equal(refused.total(), 0, "the refused host was never contacted");
});

test("A0743: a 503 'Just a moment' page is not thrown: exactly one request, no browser, and the owner is asked to take over", async (t) => {
  const { app, on, tool } = await served(t);
  const local = await site(t, { "/guarded": cloudflare503 });
  const opened = countingBrowser(app);
  on();
  const answer = await tool("web.page", { url: `${local.base}/guarded` });
  assert.equal(answer.challenged, true);
  assert.equal(answer.site, new URL(local.base).host);
  assert.match(answer.what, /Cloudflare/);
  assert.match(answer.takeOver, /does not try to get past/);
  assert.match(answer.takeOver, /Let Branch use my browser for this task/);
  assert.equal(local.hits("/guarded"), 1, "one request, no retry");
  assert.deepEqual(opened, [], "auto did not fall back to the browser on a challenge");

  const run = manualRun(app, "web.page");
  const handed = app.runtime.deferrals.list({ waiting: true });
  assert.equal(handed.length, 1);
  assert.equal(handed[0].id, answer.handOverId);
  assert.equal(handed[0].tool, "web.page");
  assert.equal(handed[0].runId, run.id);
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.includes("attention.needed") && kinds.includes("web.challenge"), kinds.join(","));
});

test("A0743: 403/429 challenges and short captcha pages are caught; ordinary errors and long pages with a comment captcha are not", async (t) => {
  const { on, tool } = await served(t);
  const local = await site(t, {
    "/busy": [429, "text/html", html("Too many", `<p>Checking your browser</p>`)],
    "/forbidden": [403, "text/html", html("Forbidden", `<div class="h-captcha" data-sitekey="x"></div>`)],
    "/turnstile": [200, "text/html", html("Welcome", `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"></iframe>`)],
    "/plain403": [403, "text/html", html("Forbidden", "<p>You may not read this.</p>")],
    "/blog": [200, "text/html", html("Blog", `${prose(30)}<form><div class="g-recaptcha"></div></form>`)],
  });
  on();
  for (const path of ["/busy", "/forbidden", "/turnstile"]) {
    const answer = await tool("web.page", { url: `${local.base}${path}` });
    assert.equal(answer.challenged, true, path);
    assert.equal(local.hits(path), 1, path);
  }
  await assert.rejects(tool("web.page", { url: `${local.base}/plain403` }), /HTTP 403/);
  const blog = await tool("web.page", { url: `${local.base}/blog` });
  assert.equal(blog.challenged, false);
});

test("A0743: a challenge met inside a real task is handed to the owner and the task carries on", async (t) => {
  let round = 0, url = "";
  const provider = { name: "scripted", async complete() {
    round++;
    return round === 1
      ? { content: "", toolCalls: [{ id: "p1", name: "web.page", arguments: JSON.stringify({ url }) }] }
      : { content: "The site wants a person; I handed it to you.", toolCalls: [] };
  } };
  const { app, on } = await served(t, provider);
  const local = await site(t, { "/guarded": cloudflare503 });
  url = `${local.base}/guarded`;
  on();
  const run = await app.runtime.run({ prompt: "Read that page" });
  assert.equal(run.status, "completed", run.output);
  const done = app.store.events(run.id).find((event) => event.kind === "tool.completed" && event.data.name === "web.page");
  assert.equal(done.data.result.challenged, true);
  assert.equal(local.hits("/guarded"), 1);
  assert.equal(app.runtime.deferrals.list({ waiting: true })[0].runId, run.id);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "attention.needed"));
});

const playwrightCache = join(homedir(), "Library", "Caches", "ms-playwright");
const hasChromium = existsSync(playwrightCache) && readdirSync(playwrightCache).some((name) => name.startsWith("chromium"));

test("A0743: auto reads a script-built page with Branch's own headless browser and names the route; a plain page stays plain", { skip: hasChromium ? false : "headless Chromium is not installed" }, async (t) => {
  const { app, on, tool, closers } = await served(t);
  const local = await site(t, {
    "/app": [200, "text/html", html("App", `<div id="root"></div><script>document.getElementById('root').innerHTML='<p>Rendered by script: the tower is 330 metres tall.</p>'</script>`)],
    "/article": [200, "text/html", html("Article", prose(10))],
  });
  const browser = new BranchBrowser({ allowedOrigins: [local.base] });
  browser.policy = app.web.policy;
  registerBrowser(app.registry, browser);
  closers.push(() => browser.close());
  on();
  const rendered = await tool("web.page", { url: `${local.base}/app` });
  assert.equal(rendered.route, "browser");
  assert.match(rendered.text, /Rendered by script: the tower is 330 metres tall/);
  assert.equal(local.hits("/app"), 2, "one plain read, then one browser load");
  const plain = await tool("web.page", { url: `${local.base}/article` });
  assert.equal(plain.route, "plain");
  assert.equal(local.hits("/article"), 1, "a readable page is not opened in the browser");
  const forced = await tool("web.page", { url: `${local.base}/article`, route: "browser" });
  assert.equal(forced.route, "browser");
  assert.match(forced.text, /survey team/);
  await assert.rejects(tool("web.page", { url: `http://localhost:${local.port}/article`, route: "browser" }), /not an allowed origin|blocked list/);
});

test("A0743: auto without a browser keeps the plain answer and says why the browser was not used", async (t) => {
  const { on, tool } = await served(t);
  const local = await site(t, { "/app": [200, "text/html", html("App", `<div id="root"></div><script src="/bundle.js"></script>`)] });
  on();
  const page = await tool("web.page", { url: `${local.base}/app` });
  assert.equal(page.route, "plain");
  assert.match(page.browserNote, /no browser is set up/);
  await assert.rejects(tool("web.page", { url: `${local.base}/app`, route: "browser" }), /browser route cannot be used/);
});

/* ---------- web.crawl ---------- */

const robots = `# rules for everyone
User-agent: OtherBot
User-agent: *
Disallow: /private
Allow: /private/open$
Disallow: /*.pdf$

User-agent: SomeoneElse
Disallow: /
`;

function crawlSite(port) {
  const offSite = `http://localhost:${port}/elsewhere`;
  return {
    "/robots.txt": [200, "text/plain", robots],
    "/": [200, "text/html", html("Home", `<p>Welcome home to the tower site.</p>
      <a href="/a">A</a> <a href="/a#top">A again</a> <a href='/a'>A thrice</a> <a href="/b">B</a>
      <a href="/private/secret">secret</a> <a href="/private/open">open</a> <a href="/doc.pdf">pdf</a>
      <a href="/data.json">data</a> <a href="/pic.png">pic</a> <a href="${offSite}">off site</a>
      <a href="mailto:someone@example.com">mail</a> <a href="/moved">moved</a> <a href="/c">C</a>`)],
    "/a": [200, "text/html", html("A", `<p>Page A of the site.</p><a href="/a/deep">deeper</a><a href="/">home</a>`)],
    "/a/deep": [200, "text/html", html("Deep", `<p>Deep page.</p><a href="/a/deeper">deeper still</a>`)],
    "/a/deeper": [200, "text/html", html("Deeper", "<p>Deeper page.</p>")],
    "/b": [200, "text/html", html("B", prose(80))],
    "/c": [200, "text/html", html("C", "<p>Page C.</p>")],
    "/private/open": [200, "text/html", html("Open", "<p>Open despite the private folder.</p>")],
    "/private/secret": [200, "text/html", html("Secret", "<p>Should never be read.</p>")],
    "/doc.pdf": [200, "application/pdf", "%PDF"],
    "/data.json": [200, "application/json", "{}"],
    "/pic.png": [200, "image/png", "PNG"],
  };
}

test("A1452: a two-level crawl stays on the host, obeys robots.txt (Disallow, Allow override, wildcards), dedupes and skips what is not a page", async (t) => {
  const { app, on, tool } = await served(t);
  const other = await site(t, { "/x": [200, "text/html", html("X", "<p>x</p>")] });
  const routes = crawlSite(other.port);
  routes["/moved"] = [302, "text/plain", "", { location: `http://localhost:${other.port}/x` }];
  const delays = [];
  app.webPages.sleep = async (ms) => { delays.push(ms); };
  const server = await site(t, routes);
  on();
  const result = await tool("web.crawl", { url: `${server.base}/#intro`, maxCharsPerPage: 300 });
  assert.equal(result.challenged, false);
  const read = result.pages.map((page) => new URL(page.url).pathname);
  assert.deepEqual(read, ["/", "/a", "/b", "/private/open", "/c"]);
  assert.deepEqual(result.skipped.robots.map((url) => new URL(url).pathname).sort(), ["/doc.pdf", "/private/secret"]);
  assert.deepEqual(result.skipped.notHtml.map((url) => new URL(url).pathname).sort(), ["/data.json", "/pic.png"]);
  assert.equal(result.skipped.failed.length, 1);
  assert.match(result.skipped.failed[0].reason, /localhost is on the blocked list/, "the redirect hop to a refused host was refused");
  assert.equal(other.total(), 0, "the refused host was never contacted");
  for (const path of ["/", "/a", "/b", "/c"]) assert.equal(server.hits(path), 1, `${path} read once`);
  for (const path of ["/private/secret", "/doc.pdf", "/a/deep"]) assert.equal(server.hits(path), 0, `${path} not read`);
  const b = result.pages.find((page) => page.url.endsWith("/b"));
  assert.equal(b.text.length, 300);
  assert.ok(b.droppedChars > 1000, "the dropped characters are stated");
  assert.ok(result.pages[0].links.includes(`${server.base}/a`) && !result.pages[0].links.some((link) => link.includes("#")));
  assert.ok(result.pages[0].links.includes(`http://localhost:${other.port}/elsewhere`), "off-site links are listed but not followed");
  assert.deepEqual(delays, Array(7).fill(400), "a polite pause before each of the 7 requests after the first");
});

test("A1452: depth and page caps hold, and a missing robots.txt allows everything", async (t) => {
  const { app, on, tool } = await served(t);
  app.webPages.sleep = async () => {};
  const routes = crawlSite(1);
  delete routes["/robots.txt"];
  const server = await site(t, routes);
  on();
  const deep = await tool("web.crawl", { url: server.base, maxDepth: 2, maxPages: 50 });
  const paths = deep.pages.map((page) => new URL(page.url).pathname);
  assert.ok(paths.includes("/a/deep") && !paths.includes("/a/deeper"), paths.join(","));
  assert.ok(paths.includes("/private/secret"), "no robots.txt: nothing is disallowed");
  assert.equal(server.hits("/a/deeper"), 0);
  const zero = await tool("web.crawl", { url: server.base, maxDepth: 0 });
  assert.deepEqual(zero.pages.map((page) => new URL(page.url).pathname), ["/"]);
  const capped = await tool("web.crawl", { url: server.base, maxPages: 2 });
  assert.equal(capped.pages.length, 2);
  assert.ok(capped.notVisited > 0);
  await assert.rejects(tool("web.crawl", { url: server.base, maxDepth: 4 }), /4|maxDepth|too_big|less than/i);
  await assert.rejects(tool("web.crawl", { url: server.base, maxPages: 51 }), /51|maxPages|too_big|less than/i);
});

test("A1452: a challenge mid-crawl stops the crawl with the pages so far and hands over to the owner", async (t) => {
  const { app, on, tool } = await served(t);
  app.webPages.sleep = async () => {};
  const server = await site(t, {
    "/": [200, "text/html", html("Home", `<p>Home.</p><a href="/a">A</a><a href="/gate">Gate</a><a href="/z">Z</a>`)],
    "/a": [200, "text/html", html("A", "<p>A.</p>")],
    "/gate": cloudflare503,
    "/z": [200, "text/html", html("Z", "<p>Z.</p>")],
  });
  on();
  const result = await tool("web.crawl", { url: server.base });
  assert.equal(result.challenged, true);
  assert.equal(new URL(result.url).pathname, "/gate");
  assert.deepEqual(result.pages.map((page) => new URL(page.url).pathname), ["/", "/a"]);
  assert.equal(server.hits("/gate"), 1);
  assert.equal(server.hits("/z"), 0, "nothing after the challenge");
  const handed = app.runtime.deferrals.list({ waiting: true });
  assert.equal(handed.length, 1);
  assert.equal(handed[0].tool, "web.crawl");
  assert.ok(app.store.events(manualRun(app, "web.crawl").id).some((event) => event.kind === "attention.needed"));
});

test("A1452: a crawl stops when it is cancelled", async (t) => {
  const { app, on, tool } = await served(t);
  const server = await site(t, crawlSite(1));
  app.webPages.sleep = async (_ms, signal) => {
    app.runtime.cancel(manualRun(app, "web.crawl").id);
    signal.throwIfAborted();
  };
  on();
  await assert.rejects(tool("web.crawl", { url: server.base }), /Cancelled/);
  assert.equal(server.hits("/"), 1);
  assert.equal(server.hits("/a") + server.hits("/b"), 0, "no page after the cancel");
});

test("A1452: robots.txt groups, the Branch agent's own group, longest match and wildcards", () => {
  const text = `User-agent: *\nDisallow: /\n\nUser-agent: BranchAgent/2.0\nDisallow: /tmp\nAllow: /tmp/keep\nDisallow: /*.cgi$\nDisallow: /q?*secret\nDisallow:\n`;
  const allowed = robotsRules(text, "BranchAgent");
  assert.equal(allowed("/"), true, "Branch's own group replaces the * group");
  assert.equal(allowed("/tmp/x"), false);
  assert.equal(allowed("/tmp/keep/x"), true, "the longer Allow wins");
  assert.equal(allowed("/run.cgi"), false);
  assert.equal(allowed("/run.cgi?x=1"), true, "$ pins the end");
  assert.equal(allowed("/q?a=secret"), false, "* matches any run of characters");
  const tie = robotsRules("User-agent: *\nDisallow: /same\nAllow: /same\n", "BranchAgent");
  assert.equal(tie("/same/page"), true, "Allow wins a tie");
  const others = robotsRules(text, "SomeBot");
  assert.equal(others("/anything"), false);
  assert.equal(robotsRules("", "BranchAgent")("/x"), true);
  assert.equal(robotsRules("User-agent: *\nDisallow:\n", "BranchAgent")("/x"), true, "an empty Disallow is no rule");
});

/* ---------- integration review (adversarial): where a redirect may send the reader ---------- */

/**
 * A page Branch reads is somebody else's, and where it sends the reader next is somebody else's
 * choice too. Every hop is therefore put to the same network rules as the address the owner gave,
 * and a page that only ever redirects is given up on rather than followed for ever. These go
 * straight at `fetchChecked` with a real NetworkPolicy, so the rules being checked are the ones the
 * app runs with rather than the loosened ones the rest of this file needs to reach its own server.
 * The site is a server this file starts: the policy's dialling seam sends the address judged for
 * example.com there, and the reader's fetch hands each request on to Branch's checked sender.
 */
const publicNames = { "example.com": "93.184.216.34", "example.invalid": "93.184.216.35" };
/** Names are resolved from a table, so nothing here depends on this computer having a network; example.com is dialled at the local site. */
const hopPolicy = () => new NetworkPolicy({}, async (host) => {
  const address = publicNames[host];
  if (!address) throw new Error(`${host} was not meant to be looked up`);
  return [address];
}, (judged) => {
  if (judged !== publicNames["example.com"]) throw new Error(`${judged} stands for a site on the internet, which this test never reaches`);
  return "127.0.0.1";
});
/** A reader's fetch that notes each request and hands it on to Branch's checked sender; one not held to a judged address is stopped here, so no hop leaves this computer. */
const handsOn = (asked) => async (input, init) => {
  asked.push(String(input));
  if (!init?.[pinnedTo]) throw new Error(`${input} was not held to a judged address, and this test sends nothing else`);
  return pinnedFetch(input, init);
};
const hopDeps = (fetchImpl, policy = hopPolicy()) =>
  ({ policy, fetch: fetchImpl, timeoutMs: 5000, maxBytes: 100000, userAgent: "BranchAgent" });
const redirectTo = (where) => [302, "text/plain", "", { location: where }];

test("A0743: a redirect to this computer, to a private network or off the web is refused on the hop", async (t) => {
  let next = "";
  const local = await site(t, { "/start": () => redirectTo(next) });
  for (const [where, why] of [
    ["file:///etc/passwd", /Only http and https/],
    ["http://127.0.0.1:9/secret", /private or local address/],
    ["http://10.0.0.1/secret", /private or local address/],
    ["http://169.254.169.254/latest/meta-data/", /private or local address/],
    ["http://[::1]:9/secret", /private or local address/],
    ["http://localhost:9/secret", /points at this computer/],
    ["http://user:pw@example.invalid/", /embedded credentials/],
  ]) {
    next = where;
    const asked = [], start = `http://example.com:${local.port}/start`, before = local.total();
    await assert.rejects(fetchChecked(hopDeps(handsOn(asked)), start, new AbortController().signal), why, where);
    assert.deepEqual(asked, [start], `${where}: nothing was sent to the address it pointed at`);
    assert.equal(local.total() - before, 1, `${where}: the page itself was read once, at the local site`);
  }
});

test("A0743: a page that only ever redirects is given up on, and the hops are counted", async (t) => {
  const local = await site(t, {
    "/a": () => redirectTo(`http://example.com:${local.port}/b`),
    "/b": () => redirectTo(`http://example.com:${local.port}/a`),
  });
  const asked = [];
  await assert.rejects(fetchChecked(hopDeps(handsOn(asked)), `http://example.com:${local.port}/a`, new AbortController().signal),
    /redirected more than 5 times/);
  assert.equal(asked.length, 6, "the first request and five hops, then it stops");
  assert.equal(local.total(), 6, "and each of them reached the local site");
});
