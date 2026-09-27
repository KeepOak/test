/* Answer aloud for sends routed to a Trunk or a room (follow-up to bugfix 6): proves in the real window, on a FRESH
   in-process engine with a scripted model (its own temp folder, a free port), that with the engine's autoReadAloud on
   a reply to "@name …" (said to the Trunk in its own conversation, and chosen to answer in this one) and each member's
   reply in a room is read aloud through POST /api/voice/speak with the words the window shows; that with it off
   nothing is; and that opening a conversation reads nothing old. Page errors must be zero.
     node design/redesign/tools/verify-aloud-rooms.cjs
   Stand-ins, all inside this script: POST /api/voice/speak answers a silent sound and the page's play() only counts
   (no voice is set up and nothing is heard). Test data it makes through the engine: two Trunks (Scout, Ledger) and a
   room with both, in the temp folder, removed at the end. */
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }

/** Answers as whichever Trunk is speaking (its system words name it), in a room and in its own conversation. */
const provider = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const text = String(request.messages.at(-1)?.content ?? "");
  const who = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim();
  if (text.startsWith("[Room")) return { content: `${who} here, in the room.`, toolCalls: [] };
  return { content: who ? `${who} here.` : "Your assistant here.", toolCalls: [] };
} };

(async () => {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-aloud-rooms-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call = async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  let played = 0;
  await context.exposeBinding("__playedOne", () => { played += 1; });
  await context.addInitScript(() => { HTMLMediaElement.prototype.play = function () { window.__playedOne(); return Promise.resolve(); }; });
  const spoken = [];
  await context.route("**/api/voice/speak", (route) => { spoken.push(JSON.parse(route.request().postData() ?? "{}").text); return route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.alloc(44) }); });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const text = () => page.locator("#conversation").innerText();
  const send = async (words) => { await page.locator("#prompt").fill(words); await page.locator("#send").click(); };
  const fresh = async () => { await page.locator("#side [data-act='newconv']").first().click().catch(async () => { await page.keyboard.press("Control+n"); }); await page.waitForTimeout(500); };
  try {
    await call("onboarding", { done: true });
    await call("trunks/switch", { part: "trunks", mode: "on" });
    await call("trunks/switch", { part: "conversations", mode: "off" });
    const scout = (await call("trunks", { name: "Scout", title: "Finds things" })).trunk;
    const ledger = (await call("trunks", { name: "Ledger", title: "Keeps the books" })).trunk;
    await app.trunks.introduced();
    await call("voice/settings", { autoReadAloud: true });
    await page.goto(base + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#prompt").waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);

    /* 1. Choosing who answers off: "@scout …" is said to Scout in its own conversation (POST /api/trunks/<id>/say). */
    const said = spoken.length;
    await send("@scout hello there");
    check("1 @scout goes to Scout's own conversation, and its reply shows", await until(async () => (await text()).includes("Scout here.")));
    await until(async () => spoken.length > said, 5000);
    check("1 with Always, Scout's reply is read aloud once, in the words shown", spoken.length === said + 1 && spoken.at(-1) === "Scout here.", JSON.stringify(spoken.slice(said)));

    /* 2. Choosing who answers on: "@scout …" in a new conversation makes Scout answer there. */
    await call("trunks/switch", { part: "conversations", mode: "on" });
    await page.reload();
    await page.locator("#prompt").waitFor();
    await page.waitForTimeout(3000);
    check("2 opening the window again reads nothing old", spoken.length === said + 1, JSON.stringify(spoken));
    await fresh();
    const chose = spoken.length;
    await send("@scout what now?");
    await until(async () => (await text()).includes("Scout here."));
    await until(async () => spoken.length > chose, 8000);
    check("2 a reply from the Trunk chosen to answer here is read aloud once", spoken.length === chose + 1 && spoken.at(-1) === "Scout here.", JSON.stringify(spoken.slice(chose)));

    /* 3. A room: each member's reply, as it arrives, without the "@name:" the window leaves off. */
    await call("trunks/switch", { part: "rooms", mode: "on" });
    const room = (await call("trunks/rooms", { name: "Price check", members: [scout.id, ledger.id] })).room;
    const beforeRoom = spoken.length;
    await page.goto(`${base}/#open=${room.sessionId}`); // the window follows the link (hashchange) and opens the room
    await page.locator(`#side [data-act="chat"][data-id="${room.sessionId}"][aria-current="true"]`).waitFor({ timeout: 15000 }).catch(() => undefined);
    const opened = await until(async () => (await call(`trunks/conversations/${room.sessionId}`)).kind === "room" && await page.evaluate((sid) => document.querySelector(`#side [data-id="${sid}"]`)?.getAttribute("aria-current") === "true", room.sessionId), 15000);
    check("3 the room opens from its link", opened);
    await page.waitForTimeout(2000); // who answers here is read once the conversation is drawn
    const inRoom = spoken.length;
    check("3 opening the room reads nothing old", inRoom === beforeRoom);
    await send("Has the price moved?");
    const both = await until(async () => { const t = await text(); return t.includes("Scout here, in the room.") && t.includes("Ledger here, in the room."); }, 20000);
    check("3 both members answer in the room", both);
    await until(async () => spoken.length > inRoom, 8000);
    await page.waitForTimeout(2500);
    const heard = spoken.slice(inRoom);
    const words = ["Scout here, in the room.", "Ledger here, in the room."];
    check("3 with Always, room replies are read aloud as they arrive, in the words shown (no @name:)",
      heard.length >= 1 && heard.length <= 2 && heard.every((w) => words.includes(w)) && new Set(heard).size === heard.length, JSON.stringify(heard));
    const last = (await call(`sessions/${room.sessionId}`)).messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "";
    check("3 and the room's newest reply is the last one read", last.endsWith(heard.at(-1) ?? "\u0000"), `${last} / ${heard.at(-1)}`);

    /* 4. With Never, nothing is read, in a room or from a Trunk. */
    await call("voice/settings", { autoReadAloud: false });
    const off = spoken.length;
    await send("And now?");
    await until(async () => (await text()).split("Ledger here, in the room.").length > 2, 20000);
    await page.waitForTimeout(3000);
    check("4 with Never, a room's replies are not read aloud", spoken.length === off, JSON.stringify(spoken.slice(off)));
    check("played once per speak call", played === spoken.length, `${played} / ${spoken.length}`);
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  await server.close().catch(() => {});
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
