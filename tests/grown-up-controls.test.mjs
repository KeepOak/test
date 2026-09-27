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

/* The prototype's three-way setting: Off / When needed / On in its order, saved, drawn again with the choice pressed, and
   nothing wider than a phone. (The prototype's redraw does not put the keyboard back on the choice; see the skipped
   focus test below.) */
test("a three-way setting keeps the prototype's order, saves and redraws with the choice pressed", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "grown-controls" });
  await openSettingsPage(page, "gateway");
  const group = page.getByRole("group", { name: "Gateway", exact: true });
  await group.waitFor();
  assert.deepEqual((await group.getByRole("button").allInnerTexts()).map((words) => words.trim()), ["Off", "When needed", "On"]);
  assert.equal((await call("/api/never-break")).mode, "off");
  await group.getByRole("button", { name: "Off", exact: true, pressed: true }).waitFor();
  await group.getByRole("button", { name: "When needed", exact: true }).click();
  for (let tries = 0; tries < 50 && (await call("/api/never-break")).mode !== "when-needed"; tries++) await page.waitForTimeout(100);
  assert.equal((await call("/api/never-break")).mode, "when-needed");
  await group.getByRole("button", { name: "When needed", exact: true, pressed: true }).waitFor();
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errors, []);
});

/* The destructive part of a page keeps its warning enclosure (Permissions › Lockdown in the prototype). */
test("the danger zone keeps its warning enclosure", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "grown-controls" });
  await openSettingsPage(page, "permissions");
  const appearance = await page.locator(".set-col .danger").evaluate((node) => {
    const style = getComputedStyle(node);
    const probe = document.createElement("span");
    probe.dataset.probe = "bad";
    node.append(probe);
    probe.style.color = "var(--bad)";
    const bad = getComputedStyle(probe).color;
    probe.remove();
    return { borderStyle: style.borderTopStyle, borderColor: style.borderTopColor, bad, radius: style.borderTopLeftRadius };
  });
  assert.equal(appearance.borderStyle, "solid");
  // Pass 17 draws the enclosure in the warning colour, softened: the same red, at any opacity.
  const rgb = (css) => { const n = css.match(/[\d.]+/g).map(Number); return css.startsWith("color(") ? n.slice(0, 3).map((v) => Math.round(v * 255)) : n.slice(0, 3); };
  assert.deepEqual(rgb(appearance.borderColor), rgb(appearance.bad));
  assert.notEqual(appearance.radius, "0px");
  assert.deepEqual(errors, []);
});

