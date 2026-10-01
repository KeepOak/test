/* MODEL-076: Settings › Models › Connections › "Retired connections and recent failures" opens a real readout: a
   connection whose service ended its route, and a connection whose latest recorded failure is recent. Headless window. */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

assert.equal(typeof chromium.launch, "function");
const provider = (extra = {}) => ({ name: "stand-in", async complete() { return { content: "ok", toolCalls: [] }; }, ...extra });

test("the retired connections row lists a retired connection and a recent failure from the engine", async (t) => {
  const seed = (app) => {
    app.runtime.models.register({ id: "old-route", name: "Old Route", provider: provider({ retired: true }), model: "m1" });
    app.runtime.models.register({ id: "flaky-route", name: "Flaky Route", provider: provider(), model: "m2" });
    app.runtime.models.register({ id: "calm-route", name: "Calm Route", provider: provider(), model: "m3" });
    app.runtime.models.health.recordFailure("flaky-route", Object.assign(new Error("The service said no"), { status: 503 }));
  };
  const { page, errors } = await newWindow(t, { seed });
  await openSettings(page, "models");
  await setLevel(page, "technical");
  await page.locator('[data-act="mtab"][data-v="connections"]').click();
  await page.locator('[data-act="demob17"][data-k="retired"]').click();
  const dialog = page.locator(".dlg .demo-b17");
  await dialog.waitFor({ timeout: 20000 });
  const text = await dialog.innerText();
  assert.match(text, /Old Route[\s\S]*Retired/);
  assert.match(text, /Flaky Route[\s\S]*Last failed/);
  assert.doesNotMatch(text, /Calm Route/, "a connection with nothing to report is not listed");
  assert.deepEqual(errors, []);
});

/* The readout's names and failures are the owner's connections, read with one GET /api/state. Each case holds that read
   in the browser, changes what the window shows (another Settings page, another dialog, a newer ask, another person, the
   lock), then lets the read answer or fail: the stale answer opens nothing and its error says nothing. */
test("a held retired-connections read opens nothing and says nothing once the page, dialog, ask, person or lock changed", async (t) => {
  const seed = (app) => {
    app.runtime.models.register({ id: "old-route", name: "Old Route", provider: provider({ retired: true }), model: "m1" });
  };
  const { page, errors } = await newWindow(t, { seed });
  let holding = false;
  const held = [];
  await page.route("**/api/state", (route) => { if (holding) held.push(route); else route.continue(); });
  const refused = "The held read was refused";
  const readout = page.locator(".dlg .demo-b17").filter({ hasText: "Old Route" });
  const toastSaid = page.locator(".toast").filter({ hasText: refused });
  const ui = (fn, arg) => page.evaluate(fn, arg);
  const toConnections = async () => {
    await page.locator('[data-act="setpage"][data-v="models"]').first().click();
    await page.locator('[data-act="mtab"][data-v="connections"]').click();
  };
  /* Clicks the row with its read held, does `change`, then answers the first held read (ok or refused) and the rest. */
  const heldAsk = async (change, ok, clicks = 1) => {
    await ui(() => import("/app/core/ui.js").then((m) => m.closeDlg()));
    holding = true;
    for (let i = 0; i < clicks; i++) await page.locator('[data-act="demob17"][data-k="retired"]').click();
    for (const end = Date.now() + 10000; held.length < clicks && Date.now() < end;) await page.waitForTimeout(50);
    assert.ok(held.length >= clicks, "the read was held");
    await change();
    holding = false;
    const [first, ...rest] = held.splice(0);
    if (ok) await first.continue(); else await first.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: refused }) });
    for (const route of rest) await route.continue();
    await page.waitForTimeout(800);
  };

  await openSettings(page, "models");
  await setLevel(page, "technical");
  await toConnections();

  await heldAsk(async () => {}, true);
  assert.equal(await readout.count(), 1, "unchanged, the answer opens the readout");
  await heldAsk(async () => {}, false);
  assert.equal(await toastSaid.count(), 1, "unchanged, the refusal is said");
  await page.locator(".toast").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));

  await heldAsk(() => page.locator('[data-act="setpage"][data-v="general"]').first().click(), true);
  assert.equal(await readout.count(), 0, "another Settings page: no readout");
  await toConnections();
  await heldAsk(() => page.locator('[data-act="setpage"][data-v="general"]').first().click(), false);
  assert.equal(await toastSaid.count(), 0, "another Settings page: the refusal is not said");
  await toConnections();

  await heldAsk(() => ui(() => import("/app/core/ui.js").then((m) => m.openDlg({ title: "Something newer", body: "<p>newer</p>", foot: "" }))), true);
  assert.equal(await readout.count(), 0, "a newer dialog is not replaced");
  assert.equal(await page.locator(".dlg").filter({ hasText: "Something newer" }).count(), 1);

  /* Two presses: the first press's read answers last, after the newer one opened its readout and it was closed. */
  await heldAsk(async () => {
    const newer = held.pop();
    await newer.continue();
    await readout.waitFor({ timeout: 10000 });
    await ui(() => import("/app/core/ui.js").then((m) => m.closeDlg()));
  }, true, 2);
  assert.equal(await readout.count(), 0, "an older ask does not reopen what the newer one showed");

  await heldAsk(() => ui(() => import("/app/core/state.js").then((m) => { m.E.profiles = { ...m.E.profiles, active: { id: "someone-else" } }; })), true);
  assert.equal(await readout.count(), 0, "another person: no readout");
  await ui(() => import("/app/core/state.js").then((m) => { m.E.profiles = { ...m.E.profiles, active: null }; }));

  await heldAsk(() => ui(() => import("/app/shell/applock.js").then((m) => m.showLock())), true);
  assert.equal(await readout.count(), 0, "a locked window: no readout");
  assert.deepEqual(errors, []);
});
