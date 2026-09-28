// One Chromium per test file. scripts/run-tests.mjs loads this before every browser test file (`--import`).
//
// 1,198 browser tests each launched their own Chromium through `chromium.launch({ headless: true })` (about a second of
// a share's four processors each, measured 2026-09-28). Here a test file's launches with the same options share one
// Chromium process, and each launch gets its own handle on it: the handle's newContext() and newPage() make fresh
// contexts (no cookie, storage, cache or page of another test is visible in them), contexts() lists only its own, and
// close() closes only its own contexts. A test that closes its handle therefore ends everything it opened, as before;
// the process itself is closed after the file's last test. tests/shared-browser.test.mjs holds that isolation.
//
// Only launches written in a test file are shared. Branch's own code (dist/) and anything in node_modules launch a
// real Chromium of their own, exactly as they do outside the tests.
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const realLaunch = chromium.launch.bind(chromium);
const shared = new Map();
const testsFolder = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/");

/** Whether the launch was written in a test file (tests/*.mjs), not in Branch's own code or a package. */
export function launchedByTest(stack = new Error().stack ?? "") {
  const frames = stack.split("\n").slice(1).map((line) => /\(?((?:file:\/\/)?[^()\s]+?):\d+:\d+\)?\s*$/.exec(line)?.[1] ?? "")
    .map((file) => (file.startsWith("file://") ? fileURLToPath(file) : file).replace(/\\/g, "/"))
    .filter((file) => file && !file.startsWith("node:") && !file.endsWith("/tests/shared-browser.mjs"));
  const caller = frames.find((file) => !file.includes("/node_modules/"));
  return Boolean(caller) && caller.startsWith(testsFolder) && !frames.slice(0, frames.indexOf(caller)).some((file) => file.includes("/dist/"));
}

/** A handle on a shared Chromium that owns the contexts it makes and closes only those. */
export function handle(real) {
  const own = new Set();
  const closedListeners = [];
  const forwarded = [];
  let closed = false;
  const track = (context) => {
    own.add(context);
    context.on("close", () => own.delete(context));
    return context;
  };
  const api = {
    async newContext(options) {
      if (closed) throw new Error("browser.newContext: Target page, context or browser has been closed");
      return track(await real.newContext(options));
    },
    // As Playwright's own browser.newPage(): a page in a context of its own, which closes with the page.
    async newPage(options) {
      const context = await api.newContext(options);
      const page = await context.newPage();
      page.once("close", () => { context.close().catch(() => undefined); });
      return page;
    },
    contexts: () => [...own],
    isConnected: () => !closed && real.isConnected(),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...own].map((context) => context.close().catch(() => undefined)));
      for (const [event, listener] of forwarded.splice(0)) real.off(event, listener);
      for (const listener of closedListeners.splice(0)) listener(proxy);
    },
    // A listener on the shared process is taken off again when this handle closes, so none outlives its test.
    on(event, listener) {
      if (event === "disconnected") closedListeners.push(listener);
      else { forwarded.push([event, listener]); real.on(event, listener); }
      return proxy;
    },
    once(event, listener) { return api.on(event, listener); },
  };
  const proxy = new Proxy(real, {
    get(target, key) {
      if (Object.hasOwn(api, key)) return api[key];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

/** One Chromium per set of launch options, launched again if it went away; a failed launch is not kept. */
async function sharedLaunch(options) {
  const key = JSON.stringify(options ?? {});
  const known = shared.get(key);
  if (!known || !(await known.catch(() => null))?.isConnected()) {
    const launching = realLaunch(options);
    launching.catch(() => shared.delete(key));
    shared.set(key, launching);
  }
  return handle(await shared.get(key));
}

// Only inside a test file's own process (node --test sets NODE_TEST_CONTEXT there).
if (process.env.NODE_TEST_CONTEXT) {
  chromium.launch = function launch(options) {
    return launchedByTest() ? sharedLaunch(options) : realLaunch(options);
  };
  // After the file's last test (and every test's own after hooks): close every shared Chromium, so the process ends.
  after(async () => {
    const browsers = await Promise.allSettled([...shared.values()]);
    shared.clear();
    await Promise.all(browsers.filter((one) => one.status === "fulfilled").map((one) => one.value.close().catch(() => undefined)));
  });
}
