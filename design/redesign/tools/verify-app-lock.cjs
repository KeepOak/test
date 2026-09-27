/* App lock, end to end in the window against a fresh throwaway engine, each step confirmed through the engine:
   set a PIN (Settings › Permissions › App lock › After 15 min), lock (the menu's Lock Branch), see the lock screen and
   nothing else, fail with a wrong PIN, unlock with the right one, change the PIN, "Always" locking a freshly opened
   window, remove the PIN (refused with a wrong one first), and Lock Branch with no PIN set.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-app-lock.cjs
   It leaves the engine with no PIN and the lock's settings as they ship. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
/* Distinctive, so the storage check below cannot match anything else. */
const PIN = "730461", PIN2 = "58203917";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function call(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const lock = async () => (await call("lock")).body;
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await settle(page, 1500);
}
async function openPermissions(page) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="permissions"]').first().click();
  await settle(page, 1200);
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
  return !kept.includes("730461") && !kept.includes("58203917");
}

async function setPin(page) {
  await openPermissions(page);
  check("App lock is live, and Off is pressed with no PIN set", !(await lock()).pinSet && (await seg(page, "off").getAttribute("aria-pressed")) === "true"
    && (await seg(page, "off").getAttribute("aria-disabled")) !== "true");
  await seg(page, "quiet").click();
  await page.locator("#pin-new-b17").fill(PIN);
  await page.locator('[data-act="applocksetb17"]').click();
  await settle(page, 1200);
  const now = await lock();
  check("After 15 min sets the PIN and the quiet minutes", now.pinSet && now.idleMinutes === 15 && !now.lockOnOpen, JSON.stringify(now));
  check("the row reads the engine's minutes", (await page.locator(".ctl", { hasText: "App lock" }).textContent()).includes("Locks after 15 quiet minutes"));
  check("the PIN is not in the answer to GET /api/lock", !JSON.stringify(now).includes(PIN));
}

async function lockAndUnlock(page) {
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
  await settle(page, 1200);
  check("Change closes its dialog", !(await page.locator(".scrim .dlg").count()));
  await call("lock", {});
  const old = await call("lock/unlock", { pin: PIN }), fresh = await call("lock/unlock", { pin: PIN2 });
  check("after Change the old PIN is refused and the new one unlocks", old.status === 403 && fresh.status === 200, `${old.status} ${fresh.status}`);
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
}

async function always(page, context) {
  await openPermissions(page);
  await seg(page, "pin").click();
  await settle(page, 1200);
  check("Always saves lock-on-open", (await lock()).lockOnOpen === true);
  check("Always reads the prototype's words", (await page.locator(".ctl", { hasText: "App lock" }).textContent()).includes("Asks for your PIN every time it opens."));
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
  await settle(page, 1200);
  const off = await lock();
  check("Off with the PIN removes it, and Always with it", off.pinSet === false && off.lockOnOpen === false, JSON.stringify(off));
  check("Off says so in the prototype's words", (await toastText(page)).includes("App lock off."));
}

async function lockWithoutPin(page) {
  await page.keyboard.press("Escape");
  await page.locator('[data-act="owner"]').first().click();
  await page.locator('[data-act="lockscreen"]').click();
  await page.locator(".lockscreen h2", { hasText: "Branch is locked" }).waitFor({ timeout: 10000 });
  check("with no PIN, Lock Branch locks the engine and draws Unlock alone", (await lock()).locked === true && !(await page.locator("#pin-unlock-b17").count()));
  check("with no PIN, the engine still answers the window (today's lock)", (await call("state")).status === 200);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 10000 });
  check("with no PIN, Unlock asks nothing", (await lock()).locked === false);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
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
  if ((await lock()).pinSet) await call("lock/pin", { pin: null, current: PIN2 });
  await call("lock/unlock", {});
  await call("lock/settings", { idleMinutes: 0, secretsWhileLocked: false, lockOnOpen: false });
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
