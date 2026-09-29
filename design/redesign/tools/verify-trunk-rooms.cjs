/* trunk-rooms-live: dragging one Trunk onto another for a room, and the toggle for who answers in a room, against a
   running engine (a fresh data folder is fine; it makes its own Trunks through the owner's routes):
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-trunk-rooms.cjs
   SHOTS=<folder> saves the drop menu, the keyboard menu and the room with its toggle (desktop light and dark, 390 wide).
   Checks, each against the engine's own GET routes:
   - dragging one Trunk's row onto another offers "Open a room with both" with both faces; choosing it makes the room
     (GET /api/trunks rooms: those two members) and opens it; dropping them again opens the same room, no second one;
   - the menu key (Shift+F10) on a Trunk's row lists the others, "Open a room with <name>"; Enter makes that room;
   - in a room, the toggle by the message box: Everyone answers, Only <the lead>, Work together; each press is saved as
     the room's rule (GET /api/trunks rooms[].rule) and drawn pressed from it;
   - no page errors. */
const { chromium } = require("playwright");
const { join } = require("node:path");

const { PORT = "3770", TOKEN, SHOTS } = process.env;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const api = async (path, body) => {
  const res = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const got = await res.json();
  if (!res.ok) throw new Error(`${path}: ${got.error ?? res.status}`);
  return got;
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const until = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };

(async () => {
  await api("onboarding", { done: true }); // the setup walk-through would cover the window
  await api("deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  for (const part of ["trunks", "rooms"]) await api("trunks/switch", { part, mode: "on" });
  const have = (await api("trunks")).trunks ?? [];
  const named = async (name) => have.find((tr) => tr.name === name) ?? (await api("trunks", { name })).trunk;
  const kim = await named("Kim"), lee = await named("Lee"), max = await named("Max");
  const roomsNow = async () => (await api("trunks")).rooms ?? [];
  const pairOf = (list, a, b) => list.filter((r) => r.members.length === 2 && r.members.includes(a) && r.members.includes(b));
  const before = await roomsNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  const row = (tr) => page.locator(`#side .list [data-trunk="${tr.id}"]`);
  for (const tr of [kim, lee, max]) await row(tr).waitFor({ timeout: 20000 });
  check("each Trunk's row in the side list can be dragged", (await row(kim).getAttribute("draggable")) === "true");

  // Drag Kim onto Lee.
  await row(kim).dragTo(row(lee));
  const both = page.locator('.pop [data-act="room-both"]');
  await both.waitFor({ timeout: 5000 });
  check("dropped on another Trunk: the menu offers a room with both", (await both.locator(".mi-t").innerText()) === "Open a room with both");
  check("with both Trunks' animated faces", (await both.locator(".av").count()) === 2);
  await page.waitForTimeout(400);
  await shot(page, "drop-menu");
  await both.click();
  const made = await until(async () => pairOf(await roomsNow(), kim.id, lee.id)[0]);
  check("the engine made a room with those two", !!made && made.members.length === 2, made?.name);
  const open = () => page.evaluate(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
  check("and the window opened it", !!(await until(async () => (await open()) === made?.sessionId)));
  await row(lee).dragTo(row(kim));
  await page.locator('.pop [data-act="room-both"]').click();
  await until(async () => (await open()) === made?.sessionId);
  check("dropping them again opens the same room, no second one", pairOf(await roomsNow(), kim.id, lee.id).length === 1);

  // The keyboard's way: the menu key on Kim's row.
  await row(kim).focus();
  await page.keyboard.press("Shift+F10");
  const items = page.locator('.pop [data-act="room-both"]');
  await items.first().waitFor({ timeout: 5000 });
  const words = await items.locator(".mi-t").allInnerTexts();
  check("the menu key lists the other Trunks", words.includes("Open a room with Lee") && words.includes("Open a room with Max"), words.join(" | "));
  await page.waitForTimeout(400);
  await shot(page, "keyboard-menu");
  await page.locator(`.pop [data-act="room-both"][data-b="${max.id}"]`).focus();
  await page.keyboard.press("Enter");
  const withMax = await until(async () => pairOf(await roomsNow(), kim.id, max.id)[0]);
  check("Enter makes the room with Max through the engine", !!withMax, withMax?.name);

  // The toggle in the room with Lee. A redraw during a drag no longer ends it (core/dom.js); this pause is for the
  // headless browser, whose drop can go missing when the drag starts while the room just made is still being opened.
  await page.waitForTimeout(800);
  await row(kim).dragTo(row(lee));
  await page.locator('.pop [data-act="room-both"]').click();
  await until(async () => (await open()) === made.sessionId);
  const seg = page.locator(".talk-tr .seg");
  await seg.waitFor({ timeout: 10000 });
  const texts = await seg.locator("button").allInnerTexts();
  check("the room's toggle: Everyone answers, Only <the lead>, Work together",
    texts.length === 3 && texts[0] === "Everyone answers" && /^Only \S/.test(texts[1]) && texts[2] === "Work together");
  for (const v of ["tag", "together", "mention"]) {
    await seg.locator(`[data-v="${v}"]`).click();
    const saved = await until(async () => (await roomsNow()).find((r) => r.id === made.id)?.rule === v);
    const drawn = await until(async () => (await page.locator('.talk-tr [aria-pressed="true"]').getAttribute("data-v").catch(() => null)) === v);
    check(`pressing ${v}: saved as the room's rule and drawn pressed`, !!saved && !!drawn);
  }
  await seg.locator('[data-v="together"]').click();
  await until(async () => (await roomsNow()).find((r) => r.id === made.id)?.rule === "together");
  await page.waitForTimeout(400);
  await shot(page, "room-toggle-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot(page, "room-toggle-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await shot(page, "room-toggle-390");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("390 wide: no sideways scroll", wide);
  await page.setViewportSize({ width: 1280, height: 860 });
  await seg.locator('[data-v="mention"]').click().catch(() => undefined);
  await until(async () => (await roomsNow()).find((r) => r.id === made.id)?.rule === "mention");

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed (rooms before: ${before.length}, after: ${(await roomsNow()).length})`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
