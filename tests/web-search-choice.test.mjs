/**
 * wire-greyed: where "search the web" goes is picked in the window (Settings › Advanced › Web search) through
 * GET/POST /api/web-search, and the pick wins over the launch settings file. Every search here goes to a server this
 * file starts on the loopback address (a SearXNG stand-in); no real search service is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savedSearchChoice, webSearchApi } from "../dist/web-search-choice.js";
import { discardTemp } from "./temp-dir.mjs";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-search-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet,
    web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

/** A SearXNG stand-in on the loopback address that answers every search with one result and counts them. */
async function searx(t) {
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(new URL(request.url, "http://127.0.0.1").searchParams.get("q"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "Tower survey", url: "https://example.org/tower", content: "measured again" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, asked };
}

test("the window's pick is read back, and until one is made the launch settings file decides", async (t) => {
  const { app, call } = await served(t);
  const first = await call("/api/web-search");
  assert.equal(first.status, 200);
  assert.equal(first.body.chosen.backend, "duckduckgo");
  assert.equal(first.body.fromLaunchFile, true);
  const brave = first.body.services.find((one) => one.id === "brave");
  assert.deepEqual([brave.needsKey, brave.keySecret, brave.hasKey], [true, "BRAVE_SEARCH_KEY", false]);
  assert.equal(first.body.services.find((one) => one.id === "duckduckgo").hasKey, null);

  const picked = await call("/api/web-search", { backend: "brave" });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.chosen.backend, "brave");
  assert.equal(picked.body.chosen.keySecret, "BRAVE_SEARCH_KEY");
  assert.equal(picked.body.fromLaunchFile, false);
  await app.store.secrets.put(app.runtime.owner, "default", "BRAVE_SEARCH_KEY", "test-brave-key");
  assert.equal((await call("/api/web-search")).body.services.find((one) => one.id === "brave").hasKey, true);
});

test("SearXNG needs its address, and a pick that can't be read is refused in plain words", async (t) => {
  const { call } = await served(t);
  const bare = await call("/api/web-search", { backend: "searxng" });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /address of your SearXNG/);
  assert.equal((await call("/api/web-search", { backend: "bing" })).status, 400);
  assert.equal((await call("/api/web-search", { backend: "brave", keySecret: "lower-case" })).status, 400);
  assert.equal((await call("/api/web-search")).body.fromLaunchFile, true, "a refused pick saves nothing");
});

test("a search goes where the owner picked, and a paid service with no key stops and says so", async (t) => {
  const { app, call } = await served(t);
  const own = await searx(t);
  assert.equal((await call("/api/web-search", { backend: "searxng", searxngUrl: own.url })).status, 200);
  const found = await app.web.search("tower survey", 3);
  assert.deepEqual(own.asked, ["tower survey"]);
  assert.equal(found[0].url, "https://example.org/tower");
  // Picking another service keeps the SearXNG address for later.
  await call("/api/web-search", { backend: "tavily" });
  assert.equal(savedSearchChoice(app.store, app.runtime.owner).searxngUrl, own.url);
  await assert.rejects(app.web.search("tower survey"), /needs its key/);
  assert.deepEqual(own.asked, ["tower survey"], "nothing else was searched");
});

test("a choice is refused when the owner switched away or Branch locked while its body was being read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-search-late-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  for (const late of ["switched", "locked"]) {
    let now = "owner";
    const deps = { store: app.store, owner, launch: () => ({ backend: "duckduckgo" }), hasSecret: () => false,
      requireOwner: () => { if (now === "switched") throw new Error("Only the owner can do this."); },
      requireUnlocked: () => { if (now === "locked") throw new Error("Unlock Branch first."); } };
    const body = async () => { now = late; return { backend: "brave" }; };
    await assert.rejects(webSearchApi(deps, "POST", body), late === "locked" ? /Unlock/ : /Only the owner/);
    assert.equal(savedSearchChoice(app.store, owner), null, `${late} mid-request: the choice is not kept`);
  }
});
