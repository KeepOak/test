/**
 * mac7/nodes: the Devices card and the message box's device picker, opened the way a person opens
 * them, at 400 px wide, in English and then in French. The device that asks to join is written in
 * by the test with a key it made; no real device is involved.
 *
 * Redesign: the old Devices card (public/devices.js, in Settings › Chat apps) is replaced by prototype.html's pairing
 * (public/app/flows/pair.js, public/app/flows/computers.js): Settings › Computer & browser › "Add a computer", then
 * "Another computer with Branch", whose dialog shows the engine's six-digit number and link, waits for the device, and
 * lets it in only once "The code matches" is ticked; the paired computer is then a card with Remove, which asks first
 * (public/app/settings/pages/computer.js). The stand-in device answers over the engine's own pairing door with the
 * number and link read off the dialog, as tools/verify-unhold-pairing.cjs does. What went with the old card: a switch
 * per thing a computer offers and its one folder (the prototype lists a computer, and a phone's "Stop lending"), and the
 * message box's device picker (the prototype has none).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newWindow, openSettings } from "./new-window-places.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the Devices card has English and real French, and no colour is written down", async () => {
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  for (const file of ["flows/pair.js", "flows/computers.js"]) {
    const source = await readFile(new URL(`app/${file}`, PUBLIC), "utf8");
    const keys = [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))];
    assert.ok(keys.length > 5, `${file}: ${keys.length} keys`);
    // Words that are spelled the same in French ("Code") are real French, not a missing translation.
    const SAME = new Set(["window.settings.computer.code"]);
    assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !SAME.has(key))), [], file);
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(source), false, `${file}: colours come from the tokens only`);
  }
});

test("pair, let in and remove a computer, in English and French at 400 px, with nothing scrolling sideways", async (t) => {
  const { app, server, page, errors, call } = await newWindow(t, { width: 400, height: 900 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const devices = () => call("/api/devices");
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { if (check(await devices())) return; await page.waitForTimeout(50); }
    assert.fail(what);
  };
  const toComputer = async () => {
    await openSettings(page);
    await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
    await page.locator('#main [data-act="comp-add"]').waitFor({ timeout: 20000 });
  };

  await toComputer();
  assert.equal((await devices()).mode, "off", "the feature ships off");
  await page.locator('#main [data-act="comp-add"]').click();
  await page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]').click();
  await page.locator('.dlg [data-act="pair-on"]').waitFor({ timeout: 20000 });
  assert.match(await page.locator(".dlg [role=alert]").innerText(), /switched off/, "the engine's refusal is shown");
  await page.locator('.dlg [data-act="pair-on"]').click();
  await page.locator(".dlg .ko-code").waitFor({ timeout: 20000 });
  const view = await devices();
  assert.equal(view.mode, "when-needed", "switched on from the window");
  const code = (await page.locator(".dlg .ko-code").innerText()).replace(/\D/g, "");
  assert.match(code, /^\d{6}$/, "the six-digit number is shown");
  const link = await page.locator(".dlg .pair-cmd15").innerText();
  assert.ok(link.includes(view.invitation.id), "and the link of the invitation the engine has on offer");
  assert.equal(await wide(), false, "the invitation fits at 400 px");

  // The stand-in: its own key, answering with what the dialog shows, with no session key at all.
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const offer = /offer=([a-f0-9]{32})/.exec(link)?.[1];
  const answered = await fetch(new URL("/api/devices/pair", server.url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer, code, name: "action.save", platform: "darwin", publicKey }) });
  assert.equal(answered.status, 200, "the device answered the invitation");
  const letIn = page.locator('.dlg [data-act="pair-letin"]');
  await letIn.waitFor({ timeout: 15000 });
  const waiting = (await devices()).requests.find((r) => r.status === "waiting");
  assert.ok((await page.locator(".dlg-b").innerText()).includes(waiting.check), "the check code the device shows, to compare");
  assert.equal(await letIn.isDisabled(), true, "not before the codes are compared");
  await page.locator("#pair-match").check();
  await letIn.click();
  await until((v) => v.devices.some((d) => d.name === "action.save"), "the Mac was let in");
  const paired = (await devices()).devices.find((d) => d.name === "action.save");
  assert.deepEqual(paired.enabled, [], "everything it could offer starts off");
  const card = page.locator("#main .comp7-card", { hasText: "action.save" });
  await card.locator('[data-act="dev-remove"]').waitFor({ timeout: 20000 });
  assert.equal(await card.locator("b").first().textContent(), "action.save", "a device name that resembles a locale key stays literal");
  assert.equal(await wide(), false, "the paired computer fits at 400 px");

  // In French: the window follows the engine's language when it opens again.
  await call("/api/look", { language: "fr" });
  await page.reload();
  const token = page.getByLabel("Session token", { exact: true });
  if (await token.isVisible().catch(() => false)) {
    await token.fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 20000 });
  await toComputer();
  const french = page.locator("#main .comp7-card", { hasText: "action.save" });
  const remove = french.locator('[data-act="dev-remove"]');
  await remove.waitFor({ timeout: 20000 });
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.equal(await remove.innerText(), fr["devices.paired.remove"], "Remove is in French");
  assert.equal(await wide(), false, "French fits at 400 px too");
  await remove.click();
  await page.locator(".dlg b", { hasText: "action.save" }).waitFor();
  assert.ok((await devices()).devices.some((d) => d.name === "action.save"), "it asks first: nothing is removed yet");
  await page.locator('.dlg [data-act="dev-remove-yes"]').click();
  await until((v) => !v.devices.some((d) => d.name === "action.save"), "the Mac was removed");
  assert.equal(app.devices.book.devices().length, 0);
  assert.deepEqual(errors, []);
});
