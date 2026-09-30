import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openSettings } from "./new-window-places.mjs";
import { waitInPage } from "./wait-in-page.mjs";

test("per-app formatting choices save separately and reload with the engine choice pressed", async (t) => {
  assert.equal(typeof chromium.launch, "function");
  const { page, call, errors } = await newWindow(t);
  await openSettings(page, "chatapps");
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  const plain = () => page.locator('[data-act="chfmt17d"][data-id="slack"][data-v="plain"]');
  await plain().click();
  await waitInPage(page, async () => {
    const { api } = await import("/app/core/api.js"); return (await api("channels/formatting")).formats.slack === "plain";
  });
  assert.deepEqual((await call("/api/channels/formatting")).formats, { slack: "plain" });
  await page.reload();
  await page.locator('#side').waitFor();
  await openSettings(page, "chatapps");
  await page.locator('[data-act="chfmt17d"][data-id="slack"][data-v="plain"][aria-pressed="true"]').waitFor();
  assert.equal(await plain().getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('[data-act="chfmt17d"][data-id="discord"][data-v="native"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-act="chfmt17d"][data-id="slack"][data-v="native"]').click();
  await waitInPage(page, async () => { const { api } = await import("/app/core/api.js"); return (await api("channels/formatting")).formats.slack === "native"; });
  assert.deepEqual(errors, []);
});
