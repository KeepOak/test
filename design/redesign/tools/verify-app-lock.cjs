/* App lock, end to end in the window against a fresh throwaway engine, each step confirmed through the engine:
   set a PIN (Settings › Permissions › App lock › After 15 min), lock (the menu's Lock Branch), see the lock screen and
   nothing else, fail with a wrong PIN, unlock with the right one, change the PIN, "Always" locking a freshly opened
   window, remove the PIN (refused with a wrong one first), and Lock Branch with no PIN set: it asks for a PIN first, in
   App lock's own dialog, then locks, including when the engine was already locked without one.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-app-lock.cjs
   It leaves the engine with no PIN and the lock's settings as they ship. */
const { chromium } = require("playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
/* Distinctive, so the storage check below cannot match anything else. */
const PIN = "730461", PIN2 = "58203917", PIN3 = "9146025";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function call(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const lock = async () => (await call("lock")).body;
/* Until the engine says so (checked every 100 ms, for up to 10 s): no fixed wait decides a result. */
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((done) => setTimeout(done, 100)); }
  return false;
}
/* Every toast the window shows, however briefly (a reload can take one away within milliseconds). */
const toasts = [];
function watchToasts(context) {
  return context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => new MutationObserver((changes) => {
    for (const change of changes) for (const node of change.addedNodes) if (node.classList?.contains("toast")) console.log(`toast: ${node.textContent}`);
  }).observe(document.body, { childList: true, subtree: true })));
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  // The window drawn, or (with "Always") its lock screen.
  await page.locator('[data-act="owner"]:visible, .lockscreen:visible').first().waitFor({ timeout: 15000 });
}
/* Settings by its gear, not Ctrl+,: a shortcut pressed while a reloaded window is still starting is lost (the "Always"
   step's old flake), where a click waits for the drawn button and goes through the window's own click handling. */
async function openPermissions(page) {
  if (!(await page.locator(".settings").count())) {
    await page.locator('.owner-row [data-act="view"][data-v="settings"]').click();
    await page.locator(".settings").waitFor({ timeout: 10000 });
  }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="permissions"]').first().click();
  // Drawn from the engine: the segment pressed is the one GET /api/lock says, so a click next means what it says.
  const now = await lock();
  const pressed = !now.pinSet ? "off" : now.lockOnOpen ? "pin" : "quiet";
  await until(async () => (await seg(page, pressed).getAttribute("aria-pressed", { timeout: 500 }).catch(() => null)) === "true");
}
/* Settings is a page of its own: its "Back to" button returns to the window, where the owner's menu is. */
async function closeSettings(page) {
  if (await page.locator(".settings").count()) await page.locator(".set-back").click();
  await page.locator('[data-act="owner"]').first().waitFor({ state: "visible", timeout: 10000 });
}
const seg = (page, v) => page.locator(`[data-act="applockb17"][data-v="${v}"]`);
const toastText = async (page) => (await page.locator(".toast").first().textContent({ timeout: 3000 }).catch(() => "")) ?? "";
/* Only the lock screen shows: the rest of the window is not visible, and the engine refuses the window's state. */
async function onlyLockScreen(page, what) {
  await page.locator(".lockscreen h2", { hasText: "Branch is locked" }).waitFor({ timeout: 10000 });
  const others = await Promise.all(["#side", "#main", "#statusbar", ".titlebar"].map((q) => page.locator(q).isVisible()));
  check(`${what}: the lock screen, and nothing else is visible`, others.every((v) => !v), others.join(","));
  check(`${what}: the engine refuses the window's state while locked (423)`, (await call("state")).status === 423);
}
async function typeUnlock(page, pin) {
  await page.locator("#pin-unlock-b17").fill(pin);
  await page.getByRole("button", { name: "Unlock" }).click();
}
async function noPinKept(page) {
  const kept = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }) + document.body.innerHTML);
  return !kept.includes("730461") && !kept.includes("58203917") && !kept.includes("9146025");
}

async function setPin(page) {
  await openPermissions(page);
  check("App lock is live, and Off is pressed with no PIN set", !(await lock()).pinSet && (await seg(page, "off").getAttribute("aria-pressed")) === "true"
    && (await seg(page, "off").getAttribute("aria-disabled")) !== "true");
  await seg(page, "quiet").click();
  await page.locator("#pin-new-b17").fill(PIN);
  await page.locator('[data-act="applocksetb17"]').click();
  await until(async () => { const got = await lock(); return got.pinSet && got.idleMinutes === 15; });
  await page.locator(".ctl", { hasText: "App lock" }).filter({ hasText: "Locks after 15 quiet minutes" }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  const now = await lock();
  check("After 15 min sets the PIN and the quiet minutes", now.pinSet && now.idleMinutes === 15 && !now.lockOnOpen, JSON.stringify(now));
  check("the row reads the engine's minutes", (await page.locator(".ctl", { hasText: "App lock" }).textContent()).includes("Locks after 15 quiet minutes"));
  check("the PIN is not in the answer to GET /api/lock", !JSON.stringify(now).includes(PIN));
}

async function lockAndUnlock(page) {
  await closeSettings(page);
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('[data-act="lockscreen"]').click();
  await onlyLockScreen(page, "Lock Branch");
  check("Lock Branch locked the engine", (await lock()).locked === true);
  await typeUnlock(page, "000000");
  check("a wrong PIN is refused in the engine's words", (await toastText(page)).includes("That PIN is not right"));
  check("the field is emptied after the request", (await page.locator("#pin-unlock-b17").inputValue()) === "");
  check("still locked after the wrong PIN", (await lock()).locked === true);
  await typeUnlock(page, PIN);
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
  check("the right PIN unlocks, and the window comes back", (await lock()).locked === false && !(await page.locator(".lockscreen").count()));
  check("the window keeps no PIN in storage or on screen", await noPinKept(page));
}

async function changePin(page) {
  await openPermissions(page);
  await page.locator('[data-act="applockchgb17"]').click();
  await page.locator("#pin-cur-b17").fill(PIN);
  await page.locator("#pin-new-b17").fill(PIN2);
  await page.locator('[data-act="applockchgokb17"]').click();
  check("Change closes its dialog", await page.locator(".scrim .dlg").waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false));
  // The PINs are tried with the window away: open, its own watch could see the lock in between and reload the window a
  // moment later, in the middle of the next step (the "Always" step's old flake).
  await page.goto("about:blank");
  await call("lock", {});
  const old = await call("lock/unlock", { pin: PIN }), fresh = await call("lock/unlock", { pin: PIN2 });
  check("after Change the old PIN is refused and the new one unlocks", old.status === 403 && fresh.status === 200, `${old.status} ${fresh.status}`);
  await page.goto(BASE + "/");
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
}

async function always(page, context) {
  await openPermissions(page);
  await seg(page, "pin").click();
  check("Always saves lock-on-open", await until(async () => (await lock()).lockOnOpen === true));
  check("Always reads the prototype's words", await page.locator(".ctl", { hasText: "App lock" }).filter({ hasText: "Asks for your PIN every time it opens." })
    .waitFor({ timeout: 10000 }).then(() => true, () => false));
  const fresh = await context.newPage();
  const errors = [];
  fresh.on("pageerror", (e) => errors.push(e.message));
  await signIn(fresh);
  await onlyLockScreen(fresh, "a window opened fresh with Always");
  await typeUnlock(fresh, PIN2);
  await fresh.locator("#main").waitFor({ state: "visible", timeout: 10000 });
  check("the fresh window opens with the PIN, and a reload of it does not ask again", (await lock()).locked === false);
  await fresh.reload();
  await fresh.locator("#main").waitFor({ state: "visible", timeout: 10000 });
  check("the fresh window had no page errors", errors.length === 0, errors.join(" | "));
  await fresh.close();
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
}

async function removePin(page) {
  await openPermissions(page);
  await seg(page, "off").click();
  await page.locator("#pin-cur-b17").fill("111111");
  await page.locator('[data-act="applockoffb17"]').click();
  check("Off with a wrong PIN is refused in the engine's words", (await toastText(page)).includes("That PIN is not right") && (await lock()).pinSet === true);
  await page.locator("#pin-cur-b17").fill(PIN2);
  await page.locator('[data-act="applockoffb17"]').click();
  await until(async () => { const got = await lock(); return got.pinSet === false && got.lockOnOpen === false; });
  const off = await lock();
  check("Off with the PIN removes it, and Always with it", off.pinSet === false && off.lockOnOpen === false, JSON.stringify(off));
  check("Off says so in the prototype's words", (await toastText(page)).includes("App lock off."));
}

/* Lock Branch with no PIN: App lock's PIN dialog, then the lock, then the lock screen after the reload. */
async function pinDialogThenLock(page, what) {
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('[data-act="lockscreen"]').click();
  await page.locator("#pin-lock-b17").waitFor({ timeout: 10000 });
  const before = await lock();
  check(`${what}: Lock Branch asks for a PIN first, and asking sets nothing`, before.pinSet === false, JSON.stringify(before));
  await page.locator("#pin-lock-b17").fill(PIN3);
  const seen = toasts.length;
  await page.locator('[data-act="lockpinb17"]').click();
  await onlyLockScreen(page, what);
  // Locked is what was asked for: no refusal is shown on the way, not even for the moment before the reload.
  const shown = toasts.slice(seen);
  check(`${what}: no refusal on the way to the lock screen`, !shown.some((text) => text.includes("Unlock it with your PIN first")), shown.join(" | "));
  const after = await lock();
  check(`${what}: the PIN is set and Branch is locked with it`, after.pinSet === true && after.locked === true, JSON.stringify(after));
  check(`${what}: the window keeps no PIN in storage or on screen`, await noPinKept(page));
  await typeUnlock(page, PIN3);
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
  check(`${what}: the new PIN unlocks`, (await lock()).locked === false);
}

async function lockWithoutPin(page) {
  await closeSettings(page);
  await pinDialogThenLock(page, "Lock Branch with no PIN");
  // The engine already locked without a PIN (the locker closed): setting the PIN takes that lock over.
  check("the PIN is removed again with the PIN", (await call("lock/pin", { pin: null, current: PIN3 })).status === 200);
  const closed = (await call("lock", {})).body;
  check("with no PIN, the engine's own lock leaves the window answered", closed.locked === true && !closed.pinSet && (await call("state")).status === 200);
  await pinDialogThenLock(page, "Lock Branch while the engine is already locked without a PIN");
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await watchToasts(context);
  const page = await context.newPage();
  page.on("console", (message) => { if (message.text().startsWith("toast: ")) toasts.push(message.text().slice(7)); });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await call("onboarding", { done: true });
    await signIn(page);
    await page.locator("#main").waitFor();
    for (const step of [setPin, lockAndUnlock, changePin, always, removePin, lockWithoutPin]) {
      try { await step(page, context); } catch (e) { check(`${step.name} finished`, false, e.message); }
    }
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  // Put back what it changed: no PIN, and the lock's settings as they ship.
  // Unlock first (nothing but status and unlock answers a Branch locked with a PIN), then remove whichever PIN is set.
  for (const pin of [PIN3, PIN2, PIN]) if ((await lock()).locked) await call("lock/unlock", { pin });
  for (const pin of [PIN3, PIN2, PIN]) if ((await lock()).pinSet) await call("lock/pin", { pin: null, current: pin });
  await call("lock/unlock", {});
  await call("lock/settings", { idleMinutes: 0, secretsWhileLocked: false, lockOnOpen: false });
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
