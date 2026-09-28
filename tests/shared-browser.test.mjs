// The one-Chromium-per-file harness (tests/shared-browser.mjs) keeps tests apart: what one test's handle opened,
// set or stored is gone for the next, and closing a handle ends everything it opened. Mutations that go red here:
// close() leaving its contexts open (a page leaks), newContext() handing back an earlier context (a cookie and
// storage leak), contexts() listing the shared process's contexts (another test's page is visible), and sharing a
// launch made outside the test files.
//
// Playwright objects are only ever compared as booleans or counts here: a failing assert.equal on a browser or a
// context prints its whole connection graph, which once took this process past 7 GB.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { launchedByTest } from "./shared-browser.mjs";
import { discardTemp } from "./temp-dir.mjs";

async function site(t) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/set") response.setHeader("set-cookie", "left=behind; Path=/");
    response.end(`<p>${request.headers.cookie ?? "no cookie"}</p>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("a test file's launches share one Chromium, and each handle sees only what it opened", async (t) => {
  const url = await site(t);
  const first = await chromium.launch({ headless: true });
  const page = await (await first.newContext()).newPage();
  await page.goto(`${url}/set`);
  await page.evaluate(() => localStorage.setItem("left", "behind"));
  assert.deepEqual((await page.context().cookies()).map((cookie) => cookie.name), ["left"]);
  const lone = await first.newPage();
  assert.equal(first.contexts().length, 2);

  const second = await chromium.launch({ headless: true });
  t.after(() => second.close());
  const fresh = await second.newContext();
  assert.ok(fresh.browser() === page.context().browser(), "one Chromium process for the file");
  assert.equal(second.contexts().length, 1, "another handle's contexts are not listed");
  assert.ok(second.contexts()[0] === fresh);
  assert.equal((await fresh.cookies()).length, 0, "no cookie from another test");
  const other = await fresh.newPage();
  await other.goto(url);
  assert.equal(await other.textContent("p"), "no cookie");
  assert.equal(await other.evaluate(() => localStorage.getItem("left")), null, "no storage from another test");

  let told = false;
  first.on("disconnected", () => { told = true; });
  await first.close();
  assert.equal(page.isClosed(), true, "closing a handle closes its pages");
  assert.equal(lone.isClosed(), true, "and the pages newPage() made");
  assert.equal(first.contexts().length, 0);
  assert.equal(first.isConnected(), false);
  assert.equal(told, true, "its disconnected listeners are told");
  await assert.rejects(first.newContext(), /has been closed/);
  assert.equal(second.isConnected(), true, "the other handle keeps working");
  assert.equal(other.isClosed(), false);
});

test("the next test starts clean: nothing an earlier test opened or set is there", async (t) => {
  const url = await site(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  assert.equal(browser.contexts().length, 0);
  const page = await browser.newPage();
  await page.goto(url);
  assert.equal(await page.textContent("p"), "no cookie");
  const real = page.context().browser();
  assert.equal(real.contexts().length, 1, "every context of earlier tests was closed");
  assert.ok(real.contexts()[0] === page.context());
});

test("only a launch written in a test file is shared; Branch's own code and packages launch their own", () => {
  assert.equal(launchedByTest(), true);
  const frame = (file) => `    at launch (${file}:10:5)`;
  const here = new URL("./x.test.mjs", import.meta.url).href;
  const dist = new URL("../dist/integrations/browser.js", import.meta.url).href;
  const pkg = new URL("../node_modules/some-package/index.js", import.meta.url).href;
  assert.equal(launchedByTest(["Error", frame(here)].join("\n")), true);
  assert.equal(launchedByTest(["Error", frame(dist), frame(here)].join("\n")), false, "Branch's own browser code");
  assert.equal(launchedByTest(["Error", frame(pkg), frame(dist), frame(here)].join("\n")), false);
  assert.equal(launchedByTest(["Error", frame(pkg), frame(here)].join("\n")), true, "a test's helper package is still the test's");
});

test("a launch made outside the test files gets a Chromium of its own", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "branch-shared-browser-"));
  t.after(() => discardTemp(folder));
  // Stands in for Branch's own browser code: a module that is not a test file calls chromium.launch().
  const module = join(folder, "own-browser.mjs");
  await writeFile(module, "export const open = (chromium) => chromium.launch({ headless: true });");
  const { open } = await import(pathToFileURL(module).href);
  const own = await open(chromium);
  const mine = await chromium.launch({ headless: true });
  t.after(async () => { await mine.close(); await own.close().catch(() => undefined); });
  const ownContext = await own.newContext();
  const myContext = await mine.newContext();
  assert.ok(ownContext.browser() !== myContext.browser(), "not the test file's shared Chromium");
  await own.close();
  assert.equal(ownContext.browser().isConnected(), false, "closing it ends that Chromium itself");
  assert.equal(mine.isConnected(), true);
});
