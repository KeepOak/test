import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "./chat-fixture.mjs";
import { saveChatIntake, readChatIntake } from "../dist/channels/intake-settings.js";

/* CHAT-255: "Photos and files reach the task" is a real switch for Telegram: off, a photo is never downloaded or given to
   the task, and the task is told that something was not read. On, as shipped. */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("with Telegram photos switched off, nothing is downloaded and the task says so", async (t) => {
  let downloads = 0;
  const { app, provider, say } = await chatFixture(t);
  const photo = () => ({ attachments: [{ name: "shed.png", sourceId: "p1", mediaType: "image/png", kind: "picture", size: png.length,
    bytes: async () => { downloads++; return png; } }] });
  assert.equal(readChatIntake(app.store, app.runtime.owner).telegramMedia, true, "on as shipped");
  await say("owner-1", "what is this", photo());
  assert.equal(downloads, 1, "on: the photo reaches the task");
  saveChatIntake(app.store, app.runtime.owner, { telegramMedia: false });
  await say("owner-1", "and this one", photo());
  assert.equal(downloads, 1, "off: not even downloaded");
  const asked = JSON.stringify(provider.requests.at(-1).messages);
  assert.match(asked, /Telegram photos and files are turned off\. 1 attachment\(s\) were not read\./);
  assert.doesNotMatch(asked, /image\/png;base64|"type":"image"/);
});

test("the Telegram card's Photos and files switch is live and saves the intake setting", async (t) => {
  const { newWindow } = await import("./new-window-places.mjs");
  const { app, page, errors } = await newWindow(t, { seed: async (branch) => {
    // A connected Telegram bot, so its card opens at the Save step with its switches.
    await branch.channels.attach({ id: "telegram", kind: "telegram", botName: () => "bot", async start() {}, async stop() {},
      async send() { return "1"; } }, { pairing: true, allowlist: [] });
  } });
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await page.locator('[data-act="ch-open"][data-v="telegram"]').click();
  const media = page.locator(".dlg #tg-media15");
  await media.waitFor();
  assert.equal(await media.isDisabled(), false, "a real switch, not a greyed picture of one");
  assert.equal(await media.isChecked(), true);
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/channels/intake") && r.request().method() === "POST");
  await media.click();
  assert.equal((await saved).status(), 200);
  assert.equal(readChatIntake(app.store, app.runtime.owner).telegramMedia, false);
  assert.deepEqual(errors, []);
});
