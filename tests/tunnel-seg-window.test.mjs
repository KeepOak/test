/* Settings › Advanced › Reach webhooks from outside: live, and every start goes through the engine's own tunnel
   (src/personal/tunnel.ts). Here the tunnel program is Node itself, which prints no public address and ends at once, so
   each start is refused in the engine's words and nothing is left running; under Lockdown the engine refuses first.
   Mutation: drop "tunnel-seg" from both markLive and the live map in public/app/settings/pages/advanced.js and this goes
   red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage, setLevel, isSoon } from "./settings-window.mjs";

const until = async (check, what) => {
  for (let tries = 0; tries < 150; tries++) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  assert.fail(what);
};

test("choosing a tunnel program starts it through the engine, and a program with no address is refused", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "tunnel-seg" });
  await call("/api/personal/tunnel", { executable: process.execPath });
  await openSettingsPage(page, "general");
  await setLevel(page, "advanced");
  await openSettingsPage(page, "advanced");
  const pick = (v) => page.locator(`[data-act="tunnel-seg"][data-v="${v}"]`);
  await until(async () => (await pick("off").getAttribute("aria-pressed")) === "true", "Off is pressed: nothing runs");
  assert.equal(await isSoon(pick("cloudflared")), false, "the choices are live");

  await pick("cloudflared").click();
  await page.locator(".toast", { hasText: "did not give a public address" }).waitFor({ timeout: 40000 });
  const after = await call("/api/personal/tunnel");
  assert.equal(after.settings.program, "cloudflared", "the program is saved");
  assert.equal(after.settings.executable, process.execPath, "a full path already saved is kept");
  assert.equal(after.status.running, false, "nothing is left running");
  await until(async () => (await pick("off").getAttribute("aria-pressed")) === "true", "still drawn Off");

  await call("/api/lockdown", { on: true });
  await pick("ngrok").click();
  await page.locator(".toast", { hasText: /Lockdown/ }).waitFor({ timeout: 40000 });
  assert.equal((await call("/api/personal/tunnel")).status.running, false);
  assert.deepEqual(errors, []);
});
