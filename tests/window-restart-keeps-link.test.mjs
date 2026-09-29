/* A switch of person restarts the window (public/app/main.js watchPerson). When the page is already on its way to another
   address, following a link to one of the new person's conversations, a restart made then would cancel that navigation
   and land back on the old address, the link gone: the person stood on a new conversation, and what they typed started
   one in Ask first (tests/helpers-household-live.test.mjs saw it in CI). The ordering is forced here: the old page's
   person check is held until the link's page is on its way, and that page is held until the check has been answered.
   Mutation: in main.js let watchPerson's restart reload whatever the page is doing, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { waitInPage } from "./wait-in-page.mjs";

const deferred = () => { let settle; const promise = new Promise((done) => { settle = done; }); return { promise, settle }; };

test("a switch of person noticed while the window follows a link keeps the linked conversation", async (t) => {
  const { app, server, page, call, errors } = await newWindow(t);
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  // The old page's person check waits here until the link's page is on its way.
  const check = deferred(), checkAsked = deferred();
  await page.route("**/api/profiles", async (route) => {
    checkAsked.settle();
    await check.promise;
    await route.continue().catch(() => undefined);
  });
  app.store.profiles.switch({ profileId: dana.id, pin: dana.pin ?? "4826" });
  await checkAsked.promise; // the old page noticed the switch and asks who is here now
  const { sessionId } = await call("/api/run", { prompt: "hello" }); // Dana's own conversation
  assert.ok(sessionId, "control: her conversation exists");

  // The link's page: held on its way until the old page's check has been answered.
  const pageIn = deferred(), onItsWay = deferred();
  const linked = (url) => new URL(url).searchParams.has("fresh");
  await page.route((url) => linked(url.href), async (route) => {
    onItsWay.settle();
    await pageIn.promise;
    await route.continue().catch(() => undefined);
  });
  const restarts = [];
  page.on("request", (request) => { if (request.isNavigationRequest() && !linked(request.url())) restarts.push(request.url()); });
  const going = page.goto(`${server.url}/?fresh=1#open=${sessionId}`, { waitUntil: "load" }).catch((error) => error);
  await onItsWay.promise;
  check.settle();
  // The old page reads the answer now; a restart it made would be a navigation of its own, seen here before the link's
  // page is let in.
  await page.waitForRequest((request) => request.isNavigationRequest() && !linked(request.url()), { timeout: 2000 }).catch(() => null);
  pageIn.settle();
  await going;
  assert.deepEqual(restarts, [], "the old page did not restart over the link it was following");
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await waitInPage(page, async (id) => (await import("/app/core/state.js")).S.chat === id, sessionId, { timeout: 15000 });
  assert.deepEqual(errors, []);
});
