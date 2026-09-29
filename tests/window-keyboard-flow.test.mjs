/* UI-106 / UI-221: the window can be worked from the keyboard alone, the way the owner works inside Branch all day.
   - Ctrl+1…9 opens the Nth conversation in the list; Ctrl+Tab and Ctrl+Shift+Tab go to the next and the previous one.
   - Ctrl+Shift+F puts the keyboard in the list's own search (from Settings too); Ctrl+F stays the conversation's Find.
   - Ctrl+L puts the keyboard in the message box from anywhere; Ctrl+I opens the Inbox.
   - The engine's other shortcuts are answered at last (Look inside, a new Trunk, Who is using Branch) and can be given
     keys in the shortcuts list, which the engine keeps.
   - A keyboard walk: every stop Tab reaches shows a focus ring, and Esc hands the keyboard back.
   Headless, one window, no sleeps.
   Mutation: in public/app/shell/extras.js drop the previousConversation branch, or nthConversation, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

const provider = { name: "scripted", async complete(request) {
  const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return { content: `Answered: ${asked}`, toolCalls: [] };
} };
const now = (page) => page.evaluate(async () => { const { S } = await import("/app/core/state.js"); return { view: S.view, chat: S.chat }; });
const rows = (page) => page.locator("#side .row[data-id]").evaluateAll((all) => all.map((r) => r.dataset.id).filter((id) => id !== "new"));
const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.act || document.activeElement?.tagName);

test("the window works from the keyboard: conversations by number and in turn, the list's search, the message box", async (t) => {
  const { app, page, call, errors } = await newWindow(t, { provider });
  for (const prompt of ["first errand", "second errand", "third errand"]) await app.runtime.run({ prompt });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll("#side .row[data-id]").length >= 3);
  const ids = await rows(page);
  assert.ok(ids.length >= 3, `three conversations listed (${ids.length})`);
  const mod = "ControlOrMeta";
  // The window's own state, held for waits (a waitForFunction must answer at once, not with a promise).
  await page.evaluate(async () => { window.__S = (await import("/app/core/state.js")).S; window.__keys = await import("/app/shell/keys.js"); });

  // By number, then in turn, round the ends.
  await page.keyboard.press(`${mod}+1`);
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", ids[0]);
  await page.keyboard.press(`${mod}+3`);
  await page.waitForFunction((id) => window.__S.chat === id, ids[2]);
  await page.keyboard.press(`${mod}+Shift+Tab`);
  await page.waitForFunction((id) => window.__S.chat === id, ids[1]);
  await page.keyboard.press(`${mod}+Tab`);
  await page.waitForFunction((id) => window.__S.chat === id, ids[2]);
  await page.keyboard.press(`${mod}+1`);
  await page.keyboard.press(`${mod}+Shift+Tab`);
  await page.waitForFunction((id) => window.__S.chat === id, ids.at(-1));

  // Ctrl+F is the conversation's Find; Ctrl+Shift+F the list's search, even from Settings.
  await page.keyboard.press(`${mod}+f`);
  await page.locator("#find9-q").waitFor();
  assert.equal(await focused(page), "find9-q");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+Comma`);
  await page.locator(".settings").waitFor();
  await page.keyboard.press(`${mod}+Shift+F`);
  await page.waitForFunction(() => document.activeElement?.id === "side-q");
  await page.keyboard.type("second");
  await page.waitForFunction(() => /second errand/.test(document.querySelector("#side")?.textContent ?? ""));
  await page.keyboard.press("Escape");

  // Ctrl+I to the Inbox, Ctrl+L straight back into the message box.
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press(`${mod}+i`);
  await page.waitForFunction(() => window.__S.view === "inbox");
  await page.keyboard.press(`${mod}+l`);
  await page.waitForFunction(() => document.activeElement?.id === "prompt");
  assert.equal((await now(page)).view, "chat");

  // The shortcuts list offers every action; one given keys there is kept by the engine and works at once.
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("?");
  const list = page.locator(".dlg .keys15");
  await list.waitFor();
  const words = await list.innerText();
  for (const action of ["Previous conversation", "Search the history", "Focus the message box", "Look inside the latest task", "Start a new Trunk", "Who is using Branch"])
    assert.match(words, new RegExp(action), `the list names "${action}"`);
  assert.match(await page.locator(".dlg .shortcuts").innerText(), /Open conversation 1 to 9 in the list/);
  await list.locator('[data-act="key15"][data-v="switchPerson"]').click();
  await page.locator(".dlg .listen15").waitFor();
  await page.keyboard.press("Alt+w");
  await page.waitForFunction(() => window.__keys.binding("switchPerson") === "Alt+W");
  assert.equal((await call("/api/comfort")).values.keys.switchPerson, "Alt+W", "the engine keeps it");
  await page.keyboard.press("Escape");
  await page.locator(".dlg").waitFor({ state: "detached" });
  await page.keyboard.press("Alt+w");
  await page.locator('.pop [data-act="yp-open"], .pop [data-act="switchto"]').first().waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.dataset?.act === "owner", null, { timeout: 5000 });

  // A keyboard walk: the first stops Tab reaches all show a focus ring.
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  const unringed = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      /* A text box is ringed by its own frame (the message box, the list's search), lit by :focus-within. */
      const ring = (node) => { const s = getComputedStyle(node); return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none"); };
      const frame = el.matches("input, textarea") ? el.closest(".composer, .sq9, .set-search, .pin-in") : null;
      const ringed = ring(el) || (!!frame && frame.matches(":focus-within") && ring(frame));
      return { ringed, name: (el.getAttribute("aria-label") || el.textContent || el.id || el.tagName).trim().slice(0, 40) };
    });
    if (stop && !stop.ringed) unringed.push(stop.name);
  }
  assert.deepEqual(unringed, [], "every stop shows where the keyboard is");
  assert.deepEqual(errors, []);
});

/* QA pass 2: the "?" list says "Close anything: Esc", and Esc in Settings closes it back to where the person was: a
   place stays that place, a conversation that conversation. A popover or a dialog in Settings closes first.
   Mutation: in public/app/main.js escape() drop the settings branch and this goes red. */
test("Esc closes Settings back to where you were", async (t) => {
  const { page, errors } = await newWindow(t, { provider });
  await page.evaluate(async () => { window.__S = (await import("/app/core/state.js")).S; });
  const mod = "ControlOrMeta";
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  await page.waitForFunction(() => window.__S.view === "inbox");
  await page.keyboard.press(`${mod}+Comma`);
  await page.waitForFunction(() => window.__S.view === "settings");
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click(); // something in Settings has the keyboard
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__S.view === "inbox");
  await page.evaluate(() => { const b = Object.assign(document.createElement("button"), { type: "button" }); b.dataset.act = "view"; b.dataset.v = "chat"; document.body.append(b); b.click(); b.remove(); });
  await page.waitForFunction(() => window.__S.view === "chat" && document.querySelector("#prompt"));
  await page.keyboard.press(`${mod}+Comma`);
  await page.waitForFunction(() => window.__S.view === "settings");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__S.view === "chat");
  assert.deepEqual(errors, []);
});
