/* Conversations like iMessage (chat/putaway.js, src/conversation-actions.ts), against a running engine:
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-conversation-actions.cjs
   SHOTS=<folder> saves the list, the menu and Recently Deleted at 1440 and 390 wide, light and dark.
   It imports three conversations of its own (POST /api/sessions/import), then, each checked through the engine's GETs:
   - the row's menu (right-click, and the row's "…") has Open, Mark as unread, Pin to top, Rename, Archive, Delete;
   - Pin to top puts it under Pinned (GET /api/sessions pinned), Rename names it (title);
   - Archive takes it out of Recent into Archived (GET /api/sessions/put-away), Unarchive brings it back;
   - Delete moves it to Recently Deleted with an Undo toast; Undo restores it; Delete again, then Restore from the list;
   - Delete now asks first, listing what goes, and removes it for good (it is no longer anyone's conversation);
   - a swipe left on a touch screen at 390 wide deletes, a swipe right pins; zero page errors;
   - with more than 100 conversations (it imports 110 more, 60 of them deleted), Recently Deleted pages through every one. */
const { chromium } = require("playwright");
const { join } = require("node:path");

const { PORT = "3792", TOKEN, SHOTS } = process.env;
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
const conversation = async (words) => (await api("sessions/import", { format: "branch-agent-conversation", version: 1,
  exportedAt: new Date().toISOString(), messages: [{ role: "user", content: words }, { role: "assistant", content: `About ${words}.` }] })).sessionId;
const listed = async (id) => (await api("sessions?limit=50")).sessions.find((s) => s.sessionId === id);

async function signIn(page) {
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
}
const row = (page, id) => page.locator(`#side .row[data-id="${id}"]`);
async function menu(page, id) {
  await row(page, id).click({ button: "right" });
  const pop = page.locator(".pop").last();
  await pop.waitFor();
  return pop;
}
async function shoot(page, name) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((s) => { document.documentElement.dataset.theme = s; }, scheme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

(async () => {
  // A fresh engine opens setup first; this engine's setup is marked finished, as finishing it would (POST /api/onboarding).
  await api("onboarding", { done: true, finished: true });
  const browser = await chromium.launch();
  const errors = [];
  // More than 100 conversations, 60 of them in Recently Deleted: every list has to page through them all.
  const filler = [], binnedBefore = (await api("sessions?limit=1")).deleted;
  for (let i = 0; i < 110; i++) filler.push(await conversation(`filler ${i}`));
  for (const id of filler.slice(0, 60)) await api(`sessions/${id}/delete`, {});
  const binnedTotal = async () => (await api("sessions?limit=1")).deleted;
  const inBin = async (id) => { for (let offset = 0; offset !== null;) { const p = await api(`sessions/put-away?kind=deleted&offset=${offset}`); if (p.deleted.some((r) => r.sessionId === id)) return true; offset = p.next.deleted; } return false; };
  const a = await conversation("the garden plan"), b = await conversation("a trip to the coast"), c = await conversation("the old invoice");

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await row(page, a).waitFor();

  let pop = await menu(page, a);
  const items = (await pop.locator(".mi .mi-t").allInnerTexts()).map((s) => s.trim());
  check("the menu: Open, Mark as read/unread, Pin to top, Rename, Archive, Delete", ["Open", "Pin to top", "Rename", "Archive", "Delete"].every((w) => items.includes(w)) && items.some((w) => /^Mark as (un)?read$/.test(w)), items.join(", "));
  check("none of them greyed", (await pop.locator('.mi[aria-disabled="true"], .mi.soon').count()) === 0);
  await shoot(page, "menu-1440");
  await pop.getByText("Pin to top", { exact: true }).click();
  check("Pin to top: the engine keeps it pinned", await until(async () => (await listed(a))?.pinned === true));
  const heading = (id) => page.evaluate((one) => { let at = document.querySelector(`#side .row[data-id="${one}"]`)?.closest(".rw18"); while (at && !at.classList.contains("lh")) at = at.previousElementSibling; return at?.textContent.trim() ?? ""; }, id);
  check("it is drawn under Pinned", await until(async () => (await heading(a)) === "Pinned"));

  // The row's "…" opens the same menu.
  await row(page, b).hover();
  await page.locator(`#side .rmore18[data-id="${b}"]`).click();
  pop = page.locator(".pop").last();
  await pop.getByText("Rename", { exact: true }).click();
  await page.locator("#cv-name").fill("Coast trip");
  await page.locator('[data-act="conv-rename-save"]').click();
  check("Rename (from the row's …): the engine keeps the name", await until(async () => (await listed(b))?.title === "Coast trip"));
  check("the row shows the name", await until(async () => (await row(page, b).innerText()).includes("Coast trip")));

  pop = await menu(page, c);
  await pop.getByText("Archive", { exact: true }).click();
  check("Archive: out of Recent", await until(async () => !(await listed(c))));
  check("Archive: under Archived", (await api("sessions/put-away")).archived.some((r) => r.sessionId === c));
  await page.locator('[data-act="putaway"][data-v="archived"]').click();
  await page.locator(`.dlg [data-act="conv-unarchive"][data-id="${c}"]`).click();
  check("Unarchive: back in Recent", await until(async () => !!(await listed(c))));

  pop = await menu(page, c);
  await pop.getByText("Delete", { exact: true }).click();
  check("Delete: in Recently Deleted with 30 days left", await until(async () => (await api("sessions/put-away")).deleted.some((r) => r.sessionId === c && r.daysLeft === 30)));
  check("the engine counts every one in Recently Deleted", (await binnedTotal()) === binnedBefore + 61, `${await binnedTotal()} of ${binnedBefore + 61}`);
  await page.locator('.toast [data-act="undo"]').click();
  check("Undo: restored", await until(async () => !!(await listed(c))));
  pop = await menu(page, c);
  await pop.getByText("Delete", { exact: true }).click();
  await until(async () => inBin(c));
  await page.locator('[data-act="putaway"][data-v="deleted"]').waitFor();
  await page.locator('[data-act="putaway"][data-v="deleted"]').click();
  const dlg = page.locator(".dlg");
  check("Recently Deleted shows days left", (await dlg.innerText()).includes("30 days left"));
  check("Recently Deleted lists every one, past the first page", await until(async () => (await dlg.locator(".prow").count()) === await binnedTotal()), `${await dlg.locator(".prow").count()} of ${await binnedTotal()}`);
  check("the oldest one is listed too", (await dlg.locator(`.prow[data-pa="${filler[0]}"]`).count()) === 1);
  await shoot(page, "recently-deleted-1440");
  await dlg.locator(`[data-act="conv-restore"][data-id="${c}"]`).click();
  check("Restore: back in Recent", await until(async () => !!(await listed(c))));
  // The list stays open while it holds others: close it.
  if (await page.locator(".dlg").count()) { await page.locator('.dlg [data-act="dlg-close"]').last().click(); await until(async () => !(await page.locator(".scrim.in17").count())); }

  pop = await menu(page, c);
  await pop.getByText("Delete", { exact: true }).click();
  await page.locator('[data-act="putaway"][data-v="deleted"]').waitFor();
  await page.locator('[data-act="putaway"][data-v="deleted"]').click();
  await page.locator(`.dlg [data-act="conv-delnow"][data-id="${c}"]`).click();
  await page.locator('[data-act="conv-delnow-go"]').waitFor();
  const asked = await page.locator(".dlg").innerText();
  check("Delete now asks first, listing what goes", /2 messages/.test(asked));
  // QA pass 5 (Q059): each count in the language's plural form, and a line only for what there is.
  check("Delete now: counts in their plural forms, no line about files when there are none",
    /This removes 2 messages and 0 tasks\./.test(asked) && !/No files|these files|\b1 tasks\b/.test(asked), asked.split("\n").find((l) => l.startsWith("This")));
  check("one task reads \"1 task\"", (await page.evaluate(async () => (await import("/i18n.js")).tc("window.chat.putaway.now-tasks", 1))) === "1 task");
  await shoot(page, "delete-now-1440");
  await page.locator('[data-act="conv-delnow-go"]').click();
  check("Delete now: gone for good", await until(async () => !(await inBin(c))
    && (await fetch(`${base}/api/sessions/${c}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status >= 400));
  await page.keyboard.press("Escape");

  // QA pass 5, on a fresh window with one more conversation to archive.
  const e = await conversation("the echo archive");
  await page.reload();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await row(page, e).waitFor();
  // Q058: in the name box Enter saves and Esc leaves the name as it was.
  pop = await menu(page, a);
  await pop.getByText("Rename", { exact: true }).click();
  await page.locator("#cv-name").fill("Garden by Enter");
  await page.locator("#cv-name").press("Enter");
  check("Rename: Enter saves", await until(async () => (await listed(a))?.title === "Garden by Enter"));
  pop = await menu(page, a);
  await pop.getByText("Rename", { exact: true }).click();
  await page.locator("#cv-name").fill("Not this");
  await page.locator("#cv-name").press("Escape");
  check("Rename: Esc closes it and keeps the name", await until(async () => !(await page.locator("#cv-name").count())) && (await listed(a))?.title === "Garden by Enter");

  // QA pass 5 (Q056): Archive takes the open conversation's row out of Recent at once, with its toast, even while the
  // engine's state is slow to come back.
  await row(page, e).click();
  await page.route("**/api/state", async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue().catch(() => undefined); });
  pop = await menu(page, e);
  await pop.getByText("Archive", { exact: true }).click();
  check("Archive: the open conversation's row leaves Recent at once", await until(async () => (await row(page, e).count()) === 0, 1500));
  check("Archive: its toast shows at once", await until(async () => (await page.locator(".toast").allInnerTexts()).some((w) => w.includes("Archived")), 1500));
  await page.unroute("**/api/state");
  // QA pass 5 (Q057): Ctrl K finds an archived conversation, marked Archived.
  await page.keyboard.press("Control+k");
  await page.locator("#pal-in").fill("echo archive");
  check("Ctrl K finds an archived conversation, marked Archived", await until(async () => /the echo archive\s*Archived/.test(await page.locator("#pal-list").innerText())));
  await page.keyboard.press("Escape");

  // 390 wide, on a touch screen: swipe left deletes, swipe right pins.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.on("pageerror", (e) => errors.push(e.message));
  await signIn(phone);
  await phone.locator('[data-act="side"]').first().click().catch(() => undefined);
  const d = await conversation("swipe me away");
  await phone.evaluate(() => window.dispatchEvent(new Event("focus")));
  await phone.reload();
  await phone.locator("#prompt").waitFor({ timeout: 60000 });
  await phone.locator('[data-act="side"]').first().click().catch(() => undefined);
  await row(phone, d).waitFor();
  await shoot(phone, "list-390");
  const swipe = async (id, dx) => {
    const box = await row(phone, id).boundingBox();
    const y = box.y + box.height / 2, x = box.x + box.width / 2;
    await row(phone, id).dispatchEvent("pointerdown", { pointerType: "touch", clientX: x, clientY: y, bubbles: true });
    for (let i = 1; i <= 6; i++) await phone.dispatchEvent("body", "pointermove", { pointerType: "touch", clientX: x + (dx * i) / 6, clientY: y, bubbles: true });
    await phone.dispatchEvent("body", "pointerup", { pointerType: "touch", clientX: x + dx, clientY: y, bubbles: true });
  };
  await swipe(b, 140);
  check("swipe right: pinned", await until(async () => (await listed(b))?.pinned === true));
  await swipe(d, -140);
  check("swipe left: in Recently Deleted", await until(async () => inBin(d)));
  await phone.locator('[data-act="putaway"][data-v="deleted"]').waitFor();
  await phone.locator('[data-act="putaway"][data-v="deleted"]').click();
  await shoot(phone, "recently-deleted-390");
  check("no sideways scroll at 390", await phone.evaluate(() => document.documentElement.scrollWidth <= 390));

  check("zero page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
