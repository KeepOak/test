/* Waits until `fn`, run in the page, answers something truthy, AWAITING what it returns. Playwright's waitForFunction does
   not await a promise: `page.waitForFunction(async () => false)` resolves at once (a promise is truthy), so every wait
   written that way checked nothing. This one asks again every `polling` ms until the answer is truthy or `timeout` passes.
   Same arguments as waitForFunction: the page, the function, its argument, { timeout, polling }. */
export async function waitInPage(page, fn, arg, { timeout = 30000, polling = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    last = await page.evaluate(fn, arg).catch((error) => { if (Date.now() > end) throw error; return undefined; });
    if (last) return last;
    if (Date.now() > end) throw new Error(`waitInPage: timed out after ${timeout} ms (${String(fn).slice(0, 120)})`);
    await new Promise((done) => setTimeout(done, polling));
  }
}
