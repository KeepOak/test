/* wire-greyed (RES-720): Settings › Advanced › Agent marketplace › Browse was greyed ("neither is in the window"). It now
   opens the engine's own markets (src/interop/agent-market.ts): a market's address kept, its assistants listed, one
   looked inside (its fingerprint checked) and brought in. Here the market is one this Branch published into its own
   workspace (POST /api/interop/market/publish), served from this computer; a file changed after publishing is refused.
   Mutation: in public/app/settings/pages/advanced.js give Browse its old data-act "soon" back: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

async function serve(t, folder) {
  const server = createServer(async (request, response) => {
    try { const body = await readFile(join(folder, decodeURIComponent(request.url.slice(1)))); response.writeHead(200); response.end(body); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("Agent marketplace: add a market, browse it, look inside, bring one in, and a changed file is refused", { timeout: 180000 }, async (t) => {
  const before = (app) => { app.web.configure({ allowPrivateAddresses: true }); app.web.policy.resolve = async () => []; };
  const { app, page, errors, call } = await settingsWindow(t, { before, name: "wire-market" });
  const published = await call("/api/interop/market/publish", { folder: "market", id: "helper-pack", name: "Helper pack", summary: "Two helpers", author: "Sam", version: "1.0.0", marketName: "Sam's market" });
  assert.ok(published.entry, JSON.stringify(published));
  const base = await serve(t, join(app.runtime.workspace, "market"));

  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const browse = page.locator('[data-act="mk-open"]');
  await browse.waitFor();
  assert.equal(await browse.getAttribute("aria-disabled"), null, "Browse is live");
  await browse.click();
  await page.locator("#mk-url").fill(`${base}/market.json`);
  await page.locator('[data-act="mk-add"]').click();
  await page.locator(`[data-act="mk-browse"][data-v="${base}/market.json"]`).click();
  await page.locator(".dlg", { hasText: "Sam's market" }).waitFor();
  await page.locator('[data-act="mk-preview"][data-v="helper-pack"]').click();
  await page.locator('[data-act="mk-install"]').waitFor();
  assert.ok(await page.locator('input[data-sw="mk-part"]').count() >= 1, "the parts a market may bring can be chosen");
  await page.locator('[data-act="mk-install"]').click();
  await page.getByText("Helper pack: ", { exact: false }).first().waitFor();
  assert.deepEqual((await call("/api/interop/market")).indexes, [`${base}/market.json`], "the market's address is kept");

  // The file changed after the market published its fingerprint: looking inside is refused, nothing is brought in.
  const file = join(app.runtime.workspace, "market", "helper-pack.branch-agent");
  await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("x")]));
  await page.locator('[data-act="mk-preview"][data-v="helper-pack"]').click();
  await page.getByText("does not match the fingerprint", { exact: false }).first().waitFor();
  assert.deepEqual(errors, []);
});
