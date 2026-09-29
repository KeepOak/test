// The verify tools' copy of tests/wait-in-page.mjs: waits until `fn`, run in the page, answers something truthy, AWAITING
// what it returns. Playwright's waitForFunction does not await a promise (`waitForFunction(async () => false)` resolves at
// once), so a wait written that way checked nothing.
async function waitInPage(page, fn, arg, { timeout = 30000, polling = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const last = await page.evaluate(fn, arg).catch((error) => { if (Date.now() > end) throw error; return undefined; });
    if (last) return last;
    if (Date.now() > end) throw new Error(`waitInPage: timed out after ${timeout} ms (${String(fn).slice(0, 120)})`);
    await new Promise((done) => setTimeout(done, polling));
  }
}
module.exports = { waitInPage };
