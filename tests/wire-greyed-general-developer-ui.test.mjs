/* wire-greyed: two Settings rows with a greyed choice.
   - General › Message times › Never had no setting. The display card keeps hideTimes now, and a message then shows no
     time, not even in its action row.
   - Developer › Status line had all three choices greyed. Default and Minimal are the display card's statusLine (null,
     or the model and the room used), which the terminal view draws; My script stays greyed with its own reason.
   Mutation: in public/app/chat/messages.js drop "|| CF.hideTimes" and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel, isSoon } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "The tower is 41 m.", toolCalls: [] }; } };

test("Message times › Never is saved and takes the time off every message", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "wire-times" });
  const run = await call("/api/run", { prompt: "How tall is the tower?" });
  const openChat = () => page.evaluate((id) => {
    const b = document.createElement("button"); b.dataset.act = "chat"; b.dataset.id = id;
    document.getElementById("app").append(b); b.click(); b.remove();
  }, run.sessionId);
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  const never = page.locator('[data-act="mtimes15"][data-v="never"]');
  await never.waitFor();
  assert.equal(await isSoon(never), false, "Never is live");
  await never.click();
  await page.locator('[data-act="mtimes15"][data-v="never"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/comfort")).values.display.hideTimes, true);
  await openChat();
  await page.locator("#main", { hasText: "The tower is 41 m." }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#main .ts15, #main .at15").count(), 0, "no time on any message");
  // On hover brings the time back to the action row.
  await call("/api/comfort", { card: "display", values: { timestamps: false, hideTimes: false } });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await openChat();
  await page.locator("#main", { hasText: "The tower is 41 m." }).waitFor({ timeout: 20000 });
  await page.locator("#main .ts15").first().waitFor({ state: "attached", timeout: 20000 });
  assert.deepEqual(errors, []);
});

test("Status line › Default and Minimal are saved; My script says why it stays greyed", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { provider, name: "wire-status-line" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical"); // Developer is listed at Technical only
  await openSettingsPage(page, "developer");
  const minimal = page.locator('[data-act="dv-status"][data-v="minimal"]');
  await minimal.waitFor();
  await page.locator('[data-act="dv-status"][data-v="default"][aria-pressed="true"]').waitFor(); // as the engine holds it
  await minimal.click();
  await page.locator('[data-act="dv-status"][data-v="minimal"][aria-pressed="true"]').waitFor();
  assert.deepEqual((await call("/api/comfort")).values.display.statusLine, ["model", "context"]);
  await page.locator('[data-act="dv-status"][data-v="default"]').click();
  await page.locator('[data-act="dv-status"][data-v="default"][aria-pressed="true"]').waitFor();
  assert.equal((await call("/api/comfort")).values.display.statusLine, null);
  const script = page.locator('[data-act="dv-status-script"]');
  assert.equal(await isSoon(script), true);
  assert.match(await script.getAttribute("data-tip"), /no script of yours/);
  assert.deepEqual(errors, []);
});
