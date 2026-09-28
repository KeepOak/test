/* Any-website mode checks each request's site against the network rules, and Chromium used to look the name up again
   itself: a site answering that second lookup with a private address (DNS rebinding) reached the home network after
   passing the check. Chromium now connects only through a local door that dials the addresses the check judged, and the
   checks of one page share one lookup per site for a few seconds, so pages don't load slowly. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { Budget } from "../dist/index.js";
import { BranchBrowser } from "../dist/integrations/browser.js";
import { BrowserPinProxy } from "../dist/integrations/browser-pin-proxy.js";
import { NetworkPolicy } from "../dist/network-policy.js";

assert.equal(typeof chromium.launch, "function");

/** A site on 127.0.0.1 standing in for a public one; it records every request it gets. */
async function site(t, pages) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    const page = pages[request.url?.split("?")[0] ?? "/"] ?? "ok";
    response.writeHead(200, { "content-type": /^</.test(page) ? "text/html" : "text/plain" }).end(page);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  return { port: server.address().port, hits };
}
const PUBLIC = "203.0.113.10";
/** Network rules whose lookups a test controls: `answers` names each site's addresses, and PUBLIC is dialled locally. */
function rules(answers, calls) {
  return new NetworkPolicy({}, async (host) => { calls.push(host); return answers[host] ?? []; },
    (address) => (address === PUBLIC ? "127.0.0.1" : address));
}
const context = (runId) => ({ owner: "owner-1", workspace: ".", runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(["browser.read"]), depth: 0 });

test("the browser connects to the address the network rules judged: a name Chromium cannot look up itself still opens", async (t) => {
  const { port, hits } = await site(t, { "/": "<title>Pinned</title><h1>Pinned</h1>" });
  const calls = [];
  const browser = new BranchBrowser({ anyWebsite: true });
  browser.policy = rules({ "pinned.test": [PUBLIC] }, calls);
  t.after(() => browser.close());
  const opened = await browser.navigate(`http://pinned.test:${port}/`, context("pinned"));
  assert.equal(opened.title, "Pinned");
  assert.deepEqual(hits, ["/"]);
});

test("a page's many requests to one site share one lookup, so the network rules don't slow a page down", async (t) => {
  const pictures = Array.from({ length: 24 }, (_, i) => `<img src="/p${i}.png">`).join("");
  const { port, hits } = await site(t, { "/": `<title>Busy</title>${pictures}<script src="/app.js"></script>` });
  const calls = [];
  const browser = new BranchBrowser({ anyWebsite: true });
  browser.policy = rules({ "busy.test": [PUBLIC] }, calls);
  t.after(() => browser.close());
  const run = context("busy");
  await browser.navigate(`http://busy.test:${port}/`, run);
  for (let i = 0; i < 40 && hits.length < 26; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(hits.length >= 25, `every picture and the script loaded (${hits.length})`);
  assert.deepEqual(calls, ["busy.test"], "one lookup for the page and every picture, script and connection");
});

test("a site whose lookup turns private is refused before a byte reaches this computer or the home network", async (t) => {
  const inside = await site(t, { "/": "<title>Inside</title>" });
  const calls = [];
  const answers = { "flip.test": [PUBLIC] };
  const policy = rules(answers, calls);
  const browser = new BranchBrowser({ anyWebsite: true });
  browser.policy = policy;
  t.after(() => browser.close());
  const run = context("flip");
  await browser.navigate(`http://flip.test:${inside.port}/`, run);
  assert.deepEqual(inside.hits, ["/"], "the public answer opened");
  answers["flip.test"] = ["127.0.0.1"]; // the second answer points home (rebinding)
  policy.configure({}); // the shared lookup is let go, as it is after a few seconds
  await assert.rejects(browser.navigate(`http://flip.test:${inside.port}/again`, run), /private|this computer/i);
  assert.deepEqual(inside.hits, ["/"], "nothing reached the private address");
});

/* The door on its own: whatever asks it (a request that somehow skipped the page check included), it dials only a
   judged address and refuses a name whose answer is private. */
async function door(t, answers, granted) {
  const calls = [];
  const proxy = new BrowserPinProxy({ rules: () => rules(answers, calls), granted });
  const server = new URL(await proxy.start());
  t.after(() => proxy.close());
  return { proxy, host: server.hostname, port: Number(server.port), calls };
}
function viaDoor(at, url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: at.host, port: at.port, path: url, method: "GET" }, (answer) => {
      let body = ""; answer.on("data", (chunk) => { body += chunk; }); answer.on("end", () => resolve({ status: answer.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}
function tunnel(at, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(at.port, at.host, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk) => { text += chunk; if (text.includes("\r\n\r\n")) { socket.destroy(); resolve(text.split("\r\n")[0]); } });
    socket.on("error", reject);
  });
}

test("the door dials only judged addresses, for plain requests and secure tunnels alike", async (t) => {
  const home = await site(t, { "/": "home" });
  const at = await door(t, { "evil.test": ["127.0.0.1"], "mixed.test": [PUBLIC, "10.0.0.5"], "good.test": [PUBLIC] });
  for (const name of ["evil.test", "mixed.test", "127.0.0.1", "localhost"]) {
    const plain = await viaDoor(at, `http://${name}:${home.port}/`);
    assert.equal(plain.status, 403, `${name}: ${plain.body}`);
    assert.match(await tunnel(at, `${name}:${home.port}`), / 403 /, name);
  }
  assert.deepEqual(home.hits, [], "no refused name reached this computer");
  const good = await viaDoor(at, `http://good.test:${home.port}/`);
  assert.equal(good.status, 200);
  assert.equal(good.body, "home");
  assert.match(await tunnel(at, `good.test:${home.port}`), / 200 /);
});

test("the door lets through only the one local page a benchmark window was granted", async (t) => {
  const page = await site(t, { "/": "task page" });
  const at = await door(t, {}, (host, port) => host === "127.0.0.1" && port === page.port);
  assert.equal((await viaDoor(at, `http://127.0.0.1:${page.port}/`)).status, 200);
  assert.equal((await viaDoor(at, `http://127.0.0.1:${page.port + 1}/`)).status, 403);
  assert.match(await tunnel(at, `127.0.0.1:${page.port}`), / 403 /, "a granted page is plain http, never a tunnel");
});

test("the shared lookup: one in flight at a time, the host rules read on every check, path rules only for the page", async () => {
  const calls = [];
  const policy = new NetworkPolicy({ allowedPaths: ["docs.test/ok/"] }, async (host) => { calls.push(host); await new Promise((r) => setTimeout(r, 20)); return host === "docs.test" ? [PUBLIC] : []; });
  const target = new URL("https://docs.test/ok/page");
  const answers = await Promise.all([policy.allowedAddresses(target), policy.allowedAddresses(target), policy.allowedAddresses(target)]);
  assert.deepEqual(answers, [[PUBLIC], [PUBLIC], [PUBLIC]]);
  assert.deepEqual(calls, ["docs.test"]);
  await assert.rejects(policy.allowedAddresses(new URL("https://docs.test/other")), /not on the allowed list/);
  assert.deepEqual(await policy.allowedAddresses(new URL("https://docs.test/"), "browser address", "host"), [PUBLIC], "a tunnel names no path");
  policy.configure({ blockedHosts: ["docs.test"] });
  await assert.rejects(policy.allowedAddresses(target), /blocked list/, "a changed rule counts at once");
  policy.configure({});
  await assert.rejects(policy.allowedAddresses(new URL("https://missing.test/")), /could not be resolved/);
  await assert.rejects(policy.allowedAddresses(new URL("https://missing.test/")), /could not be resolved/);
  assert.equal(calls.filter((host) => host === "missing.test").length, 2, "a name that was not found is asked again");
  await policy.assertAllowed(target);
  assert.equal(calls.filter((host) => host === "docs.test").length, 2, "the uncached check still looks up for itself");
});
