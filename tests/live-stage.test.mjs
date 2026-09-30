import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget, createBranch, RunArtifacts } from "../dist/index.js";
import { liveStage } from "../dist/live-stage.js";

/** A port nothing on this computer is listening on, so test files running side by side never share one. */
async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/**
 * live-stage: GET /api/panels/live (src/live-stage.ts) and the frame under it (BranchBrowser.watch).
 *
 * The frame comes from Branch's own browser tool opening a local page whose rules refuse any added style, with a
 * filled password box at the top: the frame is a JPEG of that page with the box covered. A run with no window has
 * nothing to watch. The route's own rules are held with a stand-in for the browser: only the owner's own
 * conversation is answered, the last frame is kept (not live) once the task ends, and addresses that carry a
 * key-shaped value or are not web addresses never come back as they were.
 */

const passwordPage = () => `<!doctype html><title>Frame page</title><body bgcolor="#1f9d55"><input type="password" value="correct-horse-battery-staple" size="150"><h1>Frame page</h1></body>`;

async function site() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'none'" });
    response.end(passwordPage());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

/** The colour of one pixel of a JPEG, read by a real browser drawing it onto a canvas. */
async function pixel(jpeg, x, y) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ([src, px, py]) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      return [...g.getImageData(px, py, 1, 1).data.slice(0, 3)];
    }, [`data:image/jpeg;base64,${jpeg.toString("base64")}`, x, y]);
  } finally { await browser.close(); }
}

test("a task's window is watched as a JPEG frame with its password box covered, and nothing else is", async (t) => {
  const page = await site();
  const browser = new BranchBrowser({ allowedOrigins: [page.origin] });
  t.after(async () => { await browser.close(); await page.close(); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "livestage", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read"]), depth: 0 };
  assert.equal(await browser.watch("local", "livestage"), null, "no window yet: nothing to watch");
  await registry.execute("browser.navigate", { url: `${page.origin}/` }, context);
  const seen = await browser.watch("local", "livestage");
  assert.equal(seen.url, `${page.origin}/`);
  assert.equal(seen.title, "Frame page");
  assert.deepEqual(seen.tabs, [{ url: `${page.origin}/`, title: "Frame page", active: true }]);
  assert.equal(seen.borrowed, false);
  assert.deepEqual([...seen.frame.subarray(0, 3)], [0xff, 0xd8, 0xff], "the frame is a JPEG");
  const box = await pixel(seen.frame, 300, 18), body = await pixel(seen.frame, 640, 400);
  assert.ok(box.every((v) => v < 40), `the password box is covered: ${box}`);
  assert.ok(body[1] > 120 && body[0] < 90, `the page itself is there: ${body}`);
  assert.equal(await browser.watch("local", "another-run"), null, "another run's window is not this one");
  assert.equal(await browser.watch("someone-else", "livestage"), null, "the same run under another owner is nothing");
});

/**
 * A page whose secret boxes sit in frames: one of the same site, one of another site, one of another site inside a
 * frame of another site again, and one added after the page has loaded; the page itself has a one-time-code box. Every
 * page is green, every frame is sized past its content with no border or scrollbar, and the boxes are white: the only
 * near-white in a frame of this page is a secret box left uncovered.
 */
const framed = {
  "/frames": (other) => `<!doctype html><title>Framed page</title><body bgcolor="#1f9d55">
<input type="text" autocomplete="one-time-code" value="424242" size="8">
<iframe src="/inner" width="420" height="80" frameborder="0" scrolling="no"></iframe>
<iframe src="${other}/inner" width="420" height="80" frameborder="0" scrolling="no"></iframe>
<iframe src="${other}/nest" width="460" height="120" frameborder="0" scrolling="no"></iframe>
<script>addEventListener("load", () => setTimeout(() => {
  const late = Object.assign(document.createElement("iframe"), { src: "/inner", width: 420, height: 80, frameBorder: "0", scrolling: "no" });
  late.addEventListener("load", () => { document.title = "Frames ready"; });
  document.body.append(late);
}, 300));</script></body>`,
  "/all": (other) => `<!doctype html><title>All frames</title><body bgcolor="#1f9d55">
<input type="password" value="correct-horse-battery-staple" size="24"> <input type="text" autocomplete="one-time-code" value="424242" size="8">
<iframe src="/inner" width="420" height="80" frameborder="0" scrolling="no"></iframe>
<iframe src="${other}/inner" width="420" height="80" frameborder="0" scrolling="no"></iframe>
<iframe src="${other}/nest" width="460" height="120" frameborder="0" scrolling="no"></iframe></body>`,
  "/nest": (_, self) => `<!doctype html><title>Nest</title><body bgcolor="#1f9d55"><iframe src="${self.replace("localhost", "127.0.0.1")}/inner" width="420" height="80" frameborder="0" scrolling="no"></iframe></body>`,
  "/inner": () => `<!doctype html><title>Inner</title><body bgcolor="#1f9d55"><input type="password" value="correct-horse-battery-staple" size="24">
<input type="text" autocomplete="section-a one-time-code" value="424242" size="8"><input type="text" autocomplete="new-password" value="new-horse" size="10"></body>`,
};
async function framedSite() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname, page = framed[path];
    const self = `http://${request.headers.host}`, port = server.address().port;
    const other = self.includes("localhost") ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
    response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; script-src 'unsafe-inline'" });
    response.end(page ? page(other, self) : "");
  });
  server.listen(0); // both 127.0.0.1 and localhost (which may be ::1) reach it
  await once(server, "listening");
  const port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, other: `http://localhost:${port}`, close: () => new Promise((done) => server.close(done)) };
}

/** How many pixels of a picture (a JPEG unless said) are near white, and how many are the pages' green. */
async function tally(jpeg, type = "image/jpeg") {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let white = 0, green = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++;
        if (d[i + 1] > 120 && d[i] < 90) green++;
      }
      return { white, green };
    }, `data:${type};base64,${jpeg.toString("base64")}`);
  } finally { await browser.close(); }
}

test("secret boxes inside frames are covered too: same site, another site, nested, and added after the page loaded", async (t) => {
  const site = await framedSite();
  const browser = new BranchBrowser({ allowedOrigins: [site.origin, site.other] });
  t.after(async () => { await browser.close(); await site.close(); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "livestage-frames", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read"]), depth: 0 };
  await registry.execute("browser.navigate", { url: `${site.origin}/frames` }, context);
  let seen = null;
  for (let tries = 0; tries < 60 && !(seen?.title === "Frames ready" && seen.frame); tries++) {
    seen = await browser.watch("local", "livestage-frames");
    if (!(seen?.title === "Frames ready" && seen.frame)) await new Promise((done) => setTimeout(done, 250));
  }
  assert.equal(seen?.title, "Frames ready", "the late frame was added and loaded");
  assert.ok(seen.frame, "a frame was taken");
  await new Promise((done) => setTimeout(done, 300)); // the late frame's box painted
  do seen = await browser.watch("local", "livestage-frames"); while (!seen.frame);
  const { white, green } = await tally(seen.frame);
  assert.ok(green > 100000, `the page and its frames are there: ${green} green pixels`);
  assert.equal(white, 0, "no secret box in any frame is left uncovered");
});

/** A green page whose code boxes are plain ones the page does not mark: one found by its label, one by its keypad. The
    focused box draws no ring (a ring is white in places and lies outside the box). */
const codePage = `<!doctype html><title>Code page</title><style>input:focus{outline:none}</style><body bgcolor="#1f9d55">
<label for="c">Code</label> <input id="c" type="text" size="12"> <input type="tel" inputmode="numeric" size="12"></body>`;

test("a box a saved sign-in typed a one-time code into is covered, whatever kind of box it is", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end(codePage);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  t.after(async () => { await browser.close(); await new Promise((done) => server.close(done)); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "livestage-code", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read"]), depth: 0 };
  await registry.execute("browser.navigate", { url: `${origin}/` }, context);
  const before = await browser.watch("local", "livestage-code");
  assert.ok((await tally(before.frame)).white > 0, "the boxes are white while nothing was typed");
  await browser.signInPage().type(context, "code", "Code", "424242");
  await browser.signInPage().type(context, "code", undefined, "424242");
  const seen = await browser.watch("local", "livestage-code");
  const { white, green } = await tally(seen.frame);
  assert.ok(green > 100000, `the page is there: ${green} green pixels`);
  assert.equal(white, 0, "no box a code was typed into is left uncovered");
});

test("a task working in the owner's own browser (browser.borrow) is never pictured", async (t) => {
  const page = await site();
  const browser = new BranchBrowser({ allowedOrigins: [page.origin] });
  const port = await freePort();
  const owned = await chromium.launchPersistentContext("", { headless: true, args: [`--remote-debugging-port=${port}`] });
  t.after(async () => { await browser.close(); await owned.close(); await page.close(); });
  browser.store = { get: () => ({ data: { enabled: true, port, runId: "live-borrow", grantedAt: new Date().toISOString() } }), save: () => undefined };
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "live-borrow", signal: new AbortController().signal,
    budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0 };
  await registry.execute("browser.borrow", { action: "borrow" }, context);
  await registry.execute("browser.navigate", { url: `${page.origin}/` }, context);
  const seen = await browser.watch("local", "live-borrow");
  assert.equal(seen.borrowed, true);
  assert.equal(seen.frame, null, "no frame of the owner's own browser");
  assert.equal(seen.url, `${page.origin}/`, "only the address and title of Branch's own tab");
});

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-stage-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("only the owner's own conversation is answered; the last frame outlives its task, not live", async (t) => {
  const app = await engine(t);
  const owner = app.store.profiles.scope();
  const run = app.store.createRun(owner, "open a page");
  const watched = [];
  let open = true;
  const browser = { async watch(who, runId) {
    watched.push([who, runId]);
    return open ? { url: "https://example.org/a", title: "A page", tabs: [{ url: "https://example.org/a", title: "A page", active: true }], frame, borrowed: false } : null;
  } };
  const deps = { store: app.store, owner: "local", profiles: app.store.profiles, browser };
  const now = await liveStage(deps, run.sessionId);
  assert.equal(now.runId, run.id);
  assert.equal(now.status, "running");
  assert.equal(now.browser.live, true);
  assert.equal(now.browser.preview, "ready");
  assert.equal(now.browser.url, "https://example.org/a");
  assert.equal(now.browser.frame, `data:image/jpeg;base64,${frame.toString("base64")}`);
  assert.deepEqual(watched.at(-1), ["local", run.id], "the window is asked for under the runtime's owner and this run");

  assert.deepEqual(await liveStage(deps, "not-a-conversation"), { runId: null, status: null, doing: null, browser: null });
  const other = await liveStage({ ...deps, profiles: { scope: () => owner, isOwner: () => false } }, run.sessionId);
  assert.deepEqual(other, { runId: null, status: null, doing: null, browser: null }, "a household person is shown nothing");

  const failing = { async watch() { return { url: "https://example.org/b", title: "B", tabs: [], frame: null, borrowed: false }; } };
  const between = await liveStage({ ...deps, browser: failing }, run.sessionId);
  assert.equal(between.browser.url, "https://example.org/b");
  assert.equal(between.browser.preview, "unavailable", "a stale frame is not presented as a refreshed preview");
  assert.equal(between.browser.frame, now.browser.frame, "a frame that failed mid-page leaves the last real one of that window");
  const borrowed = await liveStage({ ...deps, browser: { async watch() {
    return { url: "https://example.org/private", title: "Owner browser", tabs: [], frame: null, borrowed: true };
  } } }, run.sessionId);
  assert.equal(borrowed.browser.preview, "borrowed");
  assert.equal(borrowed.browser.frame, null, "a borrowed window never receives a previously kept preview");

  app.store.finish(run.id, "completed", "done");
  open = false;
  const after = await liveStage(deps, run.sessionId);
  assert.equal(after.runId, null, "nothing is going");
  assert.equal(after.browser.live, false, "the last frame is kept, not live");
  assert.equal(after.browser.url, "https://example.org/a");
});

test("addresses and titles never come back with a key in them, and only web addresses are shown", async (t) => {
  const app = await engine(t);
  const owner = app.store.profiles.scope();
  const run = app.store.createRun(owner, "open a page");
  const key = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const browser = { async watch() {
    return { url: `https://example.org/?key=${key}`, title: `Key ${key}`, tabs: [{ url: "file:///C:/secret.txt", title: "x", active: false }], frame: null, borrowed: false };
  } };
  const view = await liveStage({ store: app.store, owner: "local", profiles: app.store.profiles, browser }, run.sessionId);
  assert.ok(!view.browser.url.includes(key) && !view.browser.title.includes(key), JSON.stringify(view.browser));
  assert.equal(view.browser.tabs[0].url, "", "a file address is not shown");
  assert.equal(view.browser.frame, null);
});

test("only the conversation's newest task is watched: an older one left waiting with its window open is not shown", async (t) => {
  const app = await engine(t);
  const owner = app.store.profiles.scope();
  const older = app.store.createRun(owner, "open a page");
  app.store.finish(older.id, "needs_input", "may I?");
  const newer = app.store.createRun(owner, "and then", older.sessionId);
  assert.equal(app.store.runs(owner).filter((run) => run.sessionId === older.sessionId)[0].id, newer.id, "the newer task is the newest");
  const watched = [];
  const browser = { async watch(who, runId) {
    watched.push(runId);
    return runId === older.id ? { url: "https://example.org/older", title: "Older", tabs: [], frame, borrowed: false } : null;
  } };
  const view = await liveStage({ store: app.store, owner: "local", profiles: app.store.profiles, browser }, older.sessionId);
  assert.equal(view.runId, newer.id);
  assert.equal(view.browser, null, "the older task's window is not shown as the newer task's");
  assert.deepEqual(watched, [newer.id], "only the newest task's window is asked for");
});

/** The model's own picture (browser.screenshot) of a window, as its PNG bytes and the task context it was taken in. */
async function shotHarness(t, origins, runId) {
  const root = await mkdtemp(join(tmpdir(), "branch-shot-"));
  const browser = new BranchBrowser({ allowedOrigins: origins });
  browser.artifacts = new RunArtifacts(join(root, "artifacts"));
  t.after(async () => { await browser.close(); await discardTemp(root); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId, signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read"]), depth: 0 };
  const shoot = async (options = {}) => readFile((await registry.execute("browser.screenshot", options, context)).path);
  return { browser, registry, context, shoot };
}

test("browser.screenshot covers a password and a code in the page and in every frame: same site, another site, nested", async (t) => {
  const site = await framedSite();
  t.after(() => site.close());
  const { registry, context, shoot } = await shotHarness(t, [site.origin, site.other], "shot-frames");
  await registry.execute("browser.navigate", { url: `${site.origin}/all` }, context);
  await registry.execute("browser.wait", { selector: "iframe", networkIdle: true }, context);
  for (const options of [{}, { fullPage: true }, { selector: "body" }]) {
    const png = await shoot(options);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the picture is a PNG");
    const { white, green } = await tally(png, "image/png");
    assert.ok(green > 100000, `${JSON.stringify(options)}: the page and its frames are there: ${green} green pixels`);
    assert.equal(white, 0, `${JSON.stringify(options)}: no secret box in any frame is left uncovered`);
  }
  // A saved page is drawn by the browser itself, where nothing can be covered: never made with a secret in it.
  await assert.rejects(registry.execute("browser.pdf", {}, context), /holds a password or a sign-in code/);
});

test("browser.screenshot covers a box a saved sign-in typed a code into, whatever kind of box it is", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end(codePage);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { browser, registry, context, shoot } = await shotHarness(t, [origin], "shot-code");
  await registry.execute("browser.navigate", { url: `${origin}/` }, context);
  assert.ok((await tally(await shoot(), "image/png")).white > 0, "the boxes are white while nothing was typed");
  assert.ok((await registry.execute("browser.pdf", {}, context)).bytes > 0, "a page with nothing secret in it is saved");
  await browser.signInPage().type(context, "code", "Code", "424242");
  await browser.signInPage().type(context, "code", undefined, "424242");
  for (const options of [{}, { fullPage: true }, { selector: "body" }]) {
    const { white, green } = await tally(await shoot(options), "image/png");
    assert.ok(green > 10000, `${JSON.stringify(options)}: the page is there: ${green} green pixels`); // the body is one line high
    assert.equal(white, 0, `${JSON.stringify(options)}: no box a code was typed into is left uncovered`);
  }
  await assert.rejects(registry.execute("browser.pdf", {}, context), /holds a password or a sign-in code/);
  // A recording's pictures cannot be covered either, so none starts while the code is still in its box.
  await assert.rejects(browser.startRecording(context), /cannot start yet/);
});
