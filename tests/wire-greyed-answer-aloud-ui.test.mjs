/* wire-greyed: Settings › Voice › Answer aloud › When I talk was greyed ("Branch can't tell a spoken message from a typed
   one"). The voice settings keep readAloudWhen ("always" or "spoken"); dictation in the window marks the message it
   filled in, and with When I talk only the reply to such a message is read aloud. The speech route is stood in, so no
   voice service is reached.
   Mutation: in public/app/chat/aloud.js drop the readAloudWhen check, and the typed message is read aloud: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "The tower is 41 m.", toolCalls: [] }; } };

test("When I talk reads aloud the reply to a spoken message, and not to a typed one", async (t) => {
  const spoken = [];
  const route = async (page) => {
    await page.route("**/api/voice/speak", (r) => { spoken.push(JSON.parse(r.request().postData() ?? "{}").text); r.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0]) }); });
    await page.addInitScript(() => { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; });
  };
  const { page, errors, call } = await settingsWindow(t, { provider, route, name: "wire-aloud" });
  await openSettingsPage(page, "voice");
  await setLevel(page, "advanced");
  const group = page.locator(".set-col").getByRole("group", { name: "Answer aloud", exact: true });
  const talk = group.getByRole("button", { name: "When I talk", exact: true });
  assert.equal(await talk.getAttribute("aria-disabled"), null, "When I talk is live");
  await talk.click();
  await group.getByRole("button", { name: "When I talk", exact: true, pressed: true }).waitFor();
  const saved = await call("/api/voice/settings");
  assert.deepEqual([saved.autoReadAloud, saved.readAloudWhen], [true, "spoken"]);

  await page.keyboard.press("Escape");
  await page.evaluate(() => { const b = document.createElement("button"); b.dataset.act = "newconv"; document.getElementById("app").append(b); b.click(); b.remove(); });
  const box = page.locator("#prompt");
  await box.fill("typed question");
  await box.press("Enter");
  await page.locator("#main", { hasText: "The tower is 41 m." }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  assert.deepEqual(spoken, [], "a typed message's reply is not read");

  await page.evaluate(async () => (await import("/app/chat/aloud.js")).heardSpeech()); // as dictation does
  await box.fill("spoken question");
  await box.press("Enter");
  for (let tries = 0; tries < 100 && !spoken.length; tries++) await page.waitForTimeout(100);
  assert.deepEqual(spoken, ["The tower is 41 m."], "a spoken message's reply is read");
  assert.deepEqual(errors, []);
});
