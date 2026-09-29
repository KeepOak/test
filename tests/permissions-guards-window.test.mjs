/* Settings › Permissions: three controls held back for a security review are live, each behind the engine's own guard
   (public/app/settings/perm-guards.js).
   - Scan for personal details: off is less careful, so the engine's words are shown and only "Yes" turns it off.
   - Authenticator code for sensitive tools: drawn on only once an app is set up; turning it on sets one up (the key is
     shown once, the app's first code finishes it), Cancel leaves nothing half-made, and turning it off needs a code.
   - Trusted folders › Add: lists what each folder carries; Trust needs the owner's yes and is refused under Lockdown.
   Mutation: drop ...guardsLive from markLive in public/app/settings/pages/permissions.js and every case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";
import { totp } from "../dist/safety-extras/totp.js";

const until = async (check, what) => {
  for (let tries = 0; tries < 100; tries++) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  assert.fail(what);
};

async function permissions(t, name, before) {
  const f = await settingsWindow(t, { name, before });
  await openSettingsPage(f.page, "permissions");
  await setLevel(f.page, "advanced");
  // The page has read the engine once the personal-details switch (on as it ships) is drawn on.
  await until(() => f.page.locator("#f15-scan-for-personal-details").isChecked(), "the page read the engine");
  return f;
}

test("Scan for personal details turns off only after the owner's yes", async (t) => {
  const { page, errors, call } = await permissions(t, "guard-pii");
  const pii = page.locator("#f15-scan-for-personal-details");
  await until(() => pii.isChecked(), "drawn on, as the engine ships it (mask)");
  assert.equal(await isSoon(pii), false, "the switch is live");
  await pii.click();
  await page.locator(".dlg", { hasText: "less careful" }).waitFor();
  assert.equal((await call("/api/privacy")).pii.outbound, "mask", "nothing changes before the yes");
  await page.locator('.dlg [data-act="perm-loosen8"]').click();
  await until(async () => (await call("/api/privacy")).pii.outbound === "off", "the yes turns it off");
  await until(async () => !(await page.locator("#f15-scan-for-personal-details").isChecked()), "drawn off");
  await page.locator("#f15-scan-for-personal-details").click();
  await until(async () => (await call("/api/privacy")).pii.outbound === "mask", "on again at once: it only tightens");
  assert.deepEqual(errors, []);
});

test("Authenticator codes: set up with the app's first code, never half-made, turned off only with a code", async (t) => {
  const { page, errors, call } = await permissions(t, "guard-codes");
  const box = () => page.locator("#f15-authenticator-code-for-sensitive-tools");
  assert.equal(await box().isChecked(), false, "no app set up yet, so it is drawn off although the part ships on");
  assert.equal(await isSoon(box()), false, "the switch is live");
  await box().click();
  await page.locator(".dlg #auth-key8").waitFor();
  await page.locator('.dlg [data-act="auth-cancel8"]').click();
  await until(async () => (await call("/api/safety-extras")).codes.pending === false, "Cancel takes the half-made setup away");

  await box().click();
  const key = (await page.locator(".dlg #auth-key8").innerText()).trim();
  await page.locator(".dlg #auth-code8").fill("000000" === totp(key) ? "111111" : "000000");
  await page.locator('.dlg [data-act="auth-finish8"]').click();
  await page.locator(".toast", { hasText: "did not match" }).waitFor();
  assert.equal((await call("/api/safety-extras")).codes.enrolled, false, "a wrong code sets nothing up");
  await page.locator(".dlg #auth-code8").fill(totp(key));
  await page.locator('.dlg [data-act="auth-finish8"]').click();
  await until(async () => (await call("/api/safety-extras")).codes.enrolled === true, "the app's code finishes the setup");
  await until(() => box().isChecked(), "drawn on once set up");

  await box().click();
  await page.locator('.dlg [data-act="auth-off8"]').waitFor();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  assert.notEqual((await call("/api/safety-extras")).modes["code-approvals"], "off", "without a code nothing changes");
  await box().click();
  await page.locator(".dlg #auth-offcode8").fill(totp(key, Date.now() / 1000 + 30));
  await page.locator('.dlg [data-act="auth-off8"]').click();
  await until(async () => (await call("/api/safety-extras")).modes["code-approvals"] === "off", "the code turns it off");
  assert.deepEqual(errors, []);
});

test("Trusted folders › Add shows what a folder carries; Trust needs a yes and waits under Lockdown", async (t) => {
  const before = (app) => writeFile(join(app.runtime.workspace, "AGENTS.md"), "Always answer in French.\n");
  const { page, errors, call } = await permissions(t, "guard-folders", before);
  const details = page.locator(".set-col details.adv");
  if (!(await details.evaluate((d) => d.open))) await details.locator("summary").click();
  const add = page.locator('[data-act="ft-add8"]');
  assert.equal(await isSoon(add), false, "Add is live");
  await add.click();
  const row = page.locator(".dlg .ft-row8", { hasText: "Your workspace" });
  await row.waitFor();
  assert.match(await row.innerText(), /AGENTS\.md/, "what the folder carries is shown before it is trusted");

  await call("/api/lockdown", { on: true });
  await row.locator('[data-act="ft-pick8"][data-v="trust"]').click();
  await page.locator(".toast", { hasText: "Lockdown is on" }).waitFor();
  await call("/api/lockdown", { on: false });
  await page.locator('.dlg [data-act="dlg-close"]').first().click();

  await add.click();
  await page.locator('.dlg .ft-row8 [data-act="ft-pick8"][data-v="trust"]').first().click();
  await page.locator(".dlg", { hasText: "less careful" }).waitFor();
  assert.equal((await call("/api/folder-trust")).folders[0].trust, "unknown", "nothing is trusted before the yes");
  await page.locator('.dlg [data-act="perm-loosen8"]').click();
  await until(async () => (await call("/api/folder-trust")).folders[0].trust === "trusted", "the yes trusts it");
  assert.deepEqual(errors, []);
});
