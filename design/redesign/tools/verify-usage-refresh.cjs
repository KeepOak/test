/* usagefix: the status bar's "What each connection has left" reads every plan again when it opens, against a running
   engine, in a headless browser (no window is shown):
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-usage-refresh.cjs
   Checks, each against the engine's own routes:
   - a Claude Code signed in on this computer but not added (POST /api/usage/limits/look `addable`) is offered with one
     Connect; pressing it adds the connection (GET /api/usage/glance then has its row);
   - each row the engine can read (row.readable) says "Checking…" while POST /api/usage/limits/refresh is on its way,
     then what the engine answered: its windows, or its own sentence (GET /api/usage/glance agrees);
   - Check now asks the same route again; the popover is drawn again from its answer;
   - no page errors. */
const { chromium } = require("playwright");

const { PORT = "3456", TOKEN } = process.env;
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
const refreshed = (page) => page.waitForResponse((r) => r.url().endsWith("/api/usage/limits/refresh") && r.request().method() === "POST", { timeout: 150_000 });

(async () => {
  // The status bar draws its plan button beside a chosen model; a fresh engine gets Codex's program as one (nothing runs).
  if (!(await api("state")).activeModel?.presetId) {
    await api("providers/cli-agents", { id: "codex" });
    await api("models", { activePreset: "cli-codex" });
  }
  await api("onboarding", { done: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  const button = page.locator('#statusbar [data-act="usagepop"]');
  await button.waitFor({ timeout: 20000 });

  // 1. A signed-in Claude Code that is not a connection yet is offered, and one Connect adds it.
  const looked = await api("usage/limits/look", {});
  if (looked.addable?.length) {
    await button.click();
    const connect = page.locator('.pop [data-act="limconnect"]');
    await connect.waitFor({ timeout: 20000 });
    check("the popover offers the signed-in Claude Code with Connect", (await connect.textContent()).trim() === "Connect");
    const read = refreshed(page);
    await connect.click();
    const checking = await page.locator(".pop .lim", { hasText: "Checking…" }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    check("its row says Checking… while its plan is read", checking);
    const answer = await read;
    const row = (await api("usage/glance")).rows.find((r) => r.connection === "cli-claude-code");
    check("Connect added the connection (GET /api/usage/glance)", !!row && answer.status() === 200, row?.connectionName);
    await page.locator(".pop .lim", { hasText: "Checking…" }).waitFor({ state: "detached", timeout: 150_000 }).catch(() => undefined);
    const shown = await page.locator(".pop .lim", { hasText: row.connectionName }).first().textContent();
    const words = row.windows.length ? row.windows.map((w) => w.title) : [row.note];
    check("the row shows what the engine answered", words.every((w) => shown.includes(w)), words.join(" | "));
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 400);
  } else check("nothing to offer: Claude Code is connected already or not signed in here", true);

  // 2. Opening the popover reads every readable plan again.
  const before = await api("usage/glance");
  const readable = before.rows.filter((r) => r.readable);
  const read = readable.length ? refreshed(page) : null;
  await button.click();
  await page.locator(".pop .lims").waitFor({ timeout: 20000 });
  if (read) {
    check("opening it asks POST /api/usage/limits/refresh", (await read).status() === 200);
    const checkNow = page.locator('.pop [data-act="limcheck"]');
    check("Check now is there while a row can be read", await checkNow.count() === 1);
    await page.locator(".pop .lim", { hasText: "Checking…" }).waitFor({ state: "detached", timeout: 150_000 }).catch(() => undefined);
    const again = refreshed(page);
    await page.locator('.pop [data-act="limcheck"]').click();
    check("Check now asks the same route again", (await again).status() === 200);
    await page.locator(".pop .lim", { hasText: "Checking…" }).waitFor({ state: "detached", timeout: 150_000 }).catch(() => undefined);
    const after = await api("usage/glance");
    const text = await page.locator(".pop .lims").textContent();
    const agrees = after.rows.filter((r) => r.readable).every((r) => (r.windows.length ? r.windows.every((w) => text.includes(w.title)) : text.includes(r.note)));
    check("every readable row shows the engine's answer", agrees);
  } else check("no row can be read here; no Checking… is drawn", await page.locator(".pop .lim", { hasText: "Checking…" }).count() === 0);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
