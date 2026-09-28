import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace, openSettings } from "./new-window-places.mjs";
import { pickGsel } from "./gsel.mjs";

test("adding a procedure step cannot later steal focus from its No branch", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
  const { procedure } = await call("/api/autonomy/procedures", { name: "Focus check", level: "ask-to-start",
    start: { kind: "manual" }, steps: [{ title: "Read", prompt: "Read prices." }] });
  await openPlace(page, "automations", "procedures");
  await page.locator(`[data-act="flow"][data-id="${procedure.id}"]`).click();
  await page.evaluate(() => {
    const schedule = window.setTimeout;
    window.__stepFocus = [];
    window.setTimeout = (fn, ms, ...args) => {
      if (typeof fn === "function" && fn.toString().includes("getElementById(`ft-")) {
        window.__stepFocus.push(() => fn(...args));
        return 0;
      }
      return schedule(fn, ms, ...args);
    };
  });
  await page.locator('.dlg [data-act="flow-add"]').click();
  await pickGsel(page.locator(".dlg #fk-1"), "if"); // the window's own dropdown since the base's glass lists
  await page.locator(".dlg #ft-1").fill("cheaper");
  await page.locator(".dlg #fy-1").fill("Draft an order.");
  await page.locator(".dlg #fn-1").focus();
  await page.evaluate(() => { for (const fn of window.__stepFocus.splice(0)) fn(); });
  await page.keyboard.insertText("Just report the prices.");
  assert.equal(await page.locator(".dlg #ft-1").inputValue(), "cheaper");
  assert.equal(await page.locator(".dlg #fn-1").inputValue(), "Just report the prices.");
  assert.match(await page.locator(".dlg #flow-pic").innerHTML(), /If it says “cheaper”[\s\S]*No: Just report the prices\./);
  assert.deepEqual(errors, []);
});

test("an Accounts refresh keeps an unsaved secret only in its password control until Save", async (t) => {
  const { app, page, call, errors } = await newWindow(t);
  await openSettings(page, "accounts");
  const client = page.locator("#more18-google-client"), secret = page.locator("#more18-google-secret");
  await client.waitFor();
  await client.fill("1234-abc.apps.googleusercontent.com");
  await secret.fill("gocspx-refresh-regression");
  // A pending read can finish after entry; another service's changed setting forces the Accounts redraw.
  await call("/api/personal/signin/microsoft", { clientId: "changed-during-entry" });
  await page.evaluate(() => import("/app/settings/more18.js").then((m) => m.loadMore()));
  assert.equal(await secret.inputValue(), "gocspx-refresh-regression", "the unsaved input survives the redraw");
  assert.equal((await page.content()).includes("gocspx-refresh-regression"), false, "the secret is never serialized in markup");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/personal/signin/google/secret") && r.request().method() === "POST");
  await page.locator('[data-act="more18-save"][data-v="google"]').click();
  assert.equal((await saved).ok(), true);
  await page.waitForFunction(() => document.getElementById("more18-google-secret")?.value === "");
  const owner = app.runtime.owner, project = app.store.projects.active(owner).id;
  const found = await app.store.secrets.resolve(owner, project, ["GOOGLE_SIGNIN_CLIENT_SECRET"], { purpose: "test" });
  assert.equal(found.GOOGLE_SIGNIN_CLIENT_SECRET, "gocspx-refresh-regression");
  assert.equal(JSON.stringify(await call("/api/personal/signin/google")).includes("gocspx-refresh-regression"), false);
  await secret.fill("gocspx-discard-on-navigation");
  await page.locator('[data-act="setpage"][data-v="general"]').click();
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  assert.equal(await secret.inputValue(), "", "leaving Accounts discards unsaved password input");
  assert.equal((await page.content()).includes("gocspx-discard-on-navigation"), false);
  assert.deepEqual(errors, []);
});
