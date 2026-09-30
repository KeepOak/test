/* When a page has settled: no engine request of its current document in flight for three frames (the live event
   stream aside, which stays open). A screen draws what it reads once the engine has answered, so a test reads it then.

   Only the current document's requests count. A request still open when the page loads a new document (POST /api/run
   answers only when its task ends, so a reload after a switch of person leaves it open) is never reported finished or
   failed by Playwright; counting it made the wait spin until the test runner ended the file at 360 s. A navigation
   of the main frame (a reload or a new address, never a change of the hash alone) therefore starts the count again.
   Past `limit` ms the wait fails and names what is still in flight, instead of hanging. */
const counted = (request) => new URL(request.url()).pathname.startsWith("/api/") && !request.url().includes("/api/events/stream");

/** Starts counting `page`'s requests now; answers `settled()`, which resolves once the page has settled. */
export function watchSettled(page, { limit = 60000 } = {}) {
  const pending = new Set();
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) pending.clear();
    else if (counted(request)) pending.add(request);
  });
  for (const done of ["requestfinished", "requestfailed"]) page.on(done, (request) => pending.delete(request));
  return async () => {
    const until = Date.now() + limit;
    for (let quiet = 0; quiet < 3;) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))));
      quiet = pending.size ? 0 : quiet + 1;
      if (!quiet && Date.now() > until) {
        const open = [...pending].map((request) => `${request.method()} ${new URL(request.url()).pathname}`).join(", ");
        throw new Error(`The page did not settle within ${limit / 1000} s; still in flight: ${open}`);
      }
    }
  };
}
