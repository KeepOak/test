/* The approved Branch Grown Up control contract: binary settings are 40 x 24 switches,
   three-way settings are Off / When needed / On segments, and longer choices open in glass.
   These tests use the real server and settings routes so appearance cannot pass without behaviour. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettings } from "./places.mjs";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

/* The new window: every setting that is on or off is the prototype's named switch, and a live one still saves. */
test("binary settings are named switches, and More contrast still saves", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "grown-controls" });
  await openSettingsPage(page, "appearance");
  const checks = page.locator(".settings input[type=checkbox]:visible");
  assert.ok(await checks.count() >= 5, "the page has the prototype's switches");
  assert.deepEqual(await checks.evaluateAll((nodes) => nodes.filter((node) => !node.classList.contains("sw") || !node.getAttribute("aria-label"))
    .map((node) => node.id)), [], "there are no bare or unnamed checkboxes in Settings");
  const contrast = page.getByRole("checkbox", { name: "More contrast", exact: true });
  assert.equal(await contrast.isChecked(), false);
  await contrast.check();
  for (let tries = 0; tries < 50 && (await call("/api/look")).contrast !== "more"; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/look")).contrast, "more", "the change was saved");
  await page.getByRole("checkbox", { name: "More contrast", exact: true, checked: true }).waitFor();
  assert.deepEqual(errors, []);
});

/* Settings › Gateway is one on/off switch (the owner's decision: the gateway is on or off; "when-needed" and "on" both run
   it): saved as "on", drawn again from the engine switched on, and nothing wider than a phone. */
test("the gateway is one on/off switch that saves and redraws from the engine", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "grown-controls" });
  await openSettingsPage(page, "gateway");
  const gateway = page.getByRole("checkbox", { name: "Gateway", exact: true });
  await gateway.waitFor();
  assert.equal(await page.getByRole("group", { name: "Gateway", exact: true }).count(), 0, "no three-way left");
  assert.equal((await call("/api/never-break")).mode, "off");
  await page.waitForFunction(() => { const sw = document.querySelector("#main #gw-mode"); return sw && !sw.disabled && !sw.checked; });
  await gateway.click();
  // QA retest 2026-09-28 (G1): the Gateway switch runs the gateway ("when-needed") and leaves "Carry on interrupted work",
  // the switch that saves "on", as it was.
  for (let tries = 0; tries < 50 && (await call("/api/never-break")).mode === "off"; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/never-break")).mode, "when-needed");
  await page.waitForFunction(() => document.querySelector("#main #gw-mode")?.checked === true);
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errors, []);
});

/* The destructive part of a page keeps its warning enclosure (Permissions › Lockdown in the prototype). */
test("the danger zone keeps its warning enclosure", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "grown-controls" });
  await openSettingsPage(page, "permissions");
  // The page draws again once the engine answers, which can take the node away mid-read (its style then reads empty),
  // so the enclosure as drawn now is read again for a short while.
  const read = () => page.locator(".set-col .danger").evaluate((node) => {
    if (!node.isConnected) return null;
    const style = getComputedStyle(node);
    const probe = document.createElement("span");
    probe.dataset.probe = "bad";
    node.append(probe);
    probe.style.color = "var(--bad)";
    const bad = getComputedStyle(probe).color;
    probe.remove();
    return node.isConnected ? { borderStyle: style.borderTopStyle, borderColor: style.borderTopColor, bad, radius: style.borderTopLeftRadius } : null;
  });
  let appearance = await read();
  for (let tries = 0; !appearance && tries < 20; tries++) { await page.waitForTimeout(100); appearance = await read(); }
  assert.equal(appearance.borderStyle, "solid");
  // Pass 17 draws the enclosure in the warning colour, softened: the same red, at any opacity.
  const rgb = (css) => { const n = css.match(/[\d.]+/g).map(Number); return css.startsWith("color(") ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3); };
  assert.deepEqual(rgb(appearance.borderColor), rgb(appearance.bad));
  assert.notEqual(appearance.radius, "0px");
  assert.deepEqual(errors, []);
});


/* Settings reads nothing before sign-in, so General reads the settings kit as it first opens: its kit-backed switch is
   drawn on that first open, not only after leaving General and coming back. */
test("General draws its kit-backed switch the first time Settings opens", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "grown-kit" });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator('[data-act="setpage"][data-v="general"][aria-current="true"]').waitFor();
  await page.locator(".set-col #g-cmds").waitFor({ state: "attached", timeout: 15000 });
  assert.deepEqual(errors, []);
});
