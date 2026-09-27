// Verifies the shell and sidebar controls made live on claude/rw3-shell, against a running engine: each control is
// clicked in the real window and the change is read back from the engine's own GET route (or, for the background file
// the engine never sees, from the window's own storage). Page errors are recorded and must be zero.
// Prepare a throwaway engine first: it makes Trunks, a room and a node, switches on the command catalog and
// session-commands (so /bg runs), and changes shortcuts, names and background settings:
//   BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-shell.mjs
//   BRANCH_DATA_DIR=<same> BRANCH_WORKSPACE=<same> BRANCH_PORT=<port> node dist/cli.js start
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-shell3.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
const { crc32, deflateSync } = require("node:zlib");

const PORT = process.env.PORT || "3342", TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
if (!TOKEN) { console.error("Set TOKEN to the engine's session token."); process.exit(2); }

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

const results = [];
function check(action, ok, how) { results.push([action, ok ? "PASS" : "FAIL", how]); if (!ok) console.log(`FAIL ${action}: ${how}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(150); } }

function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/* Test data made through the engine: two Trunks, a room of both, another Branch computer in the list, /bg switched on. */
async function fixtures(stamp) {
  for (const part of ["trunks", "rooms"]) await api("trunks/switch", { part, mode: "on" });
  await api("commands/settings", { mode: "on" });
  await api("autonomy/switch", { part: "session-commands", mode: "on" });
  const a = (await api("trunks", { name: `Verify ${stamp}`, description: "Checks the window" })).trunk;
  const b = (await api("trunks", { name: `Second ${stamp}`, description: "Keeps it company" })).trunk;
  const room = (await api("trunks/rooms", { name: `Room ${stamp}`, members: [a.id, b.id] })).room;
  await api("asks/nodes", { nodes: [{ id: "verify-node", name: "verify node", address: "http://127.0.0.1:9", secret: "verify-node-key", labels: ["home"] }] });
  const seeded = (await api("state")).runs.find((r) => (r.changes ?? []).some((c) => c.path === "notes/plan.md"));
  if (!seeded) throw new Error("Run seed-shell.mjs on the engine's data folder first");
  const device = (await api("devices")).devices[0];
  return { a, room, seeded, device };
}

async function signIn(page) {
  await api("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done, so it is marked done through the engine first
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await page.waitForTimeout(1500);
}
const live = async (page, sel) => (await page.getAttribute(sel, "aria-disabled")) !== "true";
async function rowMenu(page, sessionId) {
  await page.click(`#side .row[data-id="${sessionId}"]`, { button: "right" });
  await page.waitForSelector(".pop");
}

async function bgNew(page, stamp) {
  const before = (await api("sessions?limit=50")).sessions.length;
  await page.click('[data-act="tasks10"]');
  await page.waitForSelector('.pop [data-act="bg-new"]');
  check("bg-new (live)", await live(page, '.pop [data-act="bg-new"]'), "drawn live because GET /api/commands?surface=window lists bg");
  await page.click('.pop [data-act="bg-new"]');
  check("bg-new (draft)", (await page.inputValue("#prompt")) === "/bg ", "the message box holds /bg, focused");
  await page.keyboard.type(`bgword${stamp}`);
  await page.keyboard.press("Enter");
  const made = await until(async () => { const s = (await api("sessions?limit=50")).sessions; return s.length > before && s.some((x) => String(x.opening ?? "").includes(`bgword${stamp}`)); }, 15000);
  check("bg-new (engine)", !!made, "sent through /bg (POST /api/commands/run): GET /api/sessions has a new conversation opening with the words");
}

async function fileOpen(page, fx) {
  await page.click(`#side .row[data-id="${fx.seeded.sessionId}"]`);
  await page.waitForTimeout(600);
  await page.click('.head [data-act="pane"][data-p="activity"]');
  await page.click('#pane [data-p="files"]');
  await page.click('#pane [data-act="fileopen"][data-n="notes/plan.md"]');
  await page.waitForSelector(".dlg .diff");
  const shown = await page.$$eval(".dlg .diff div", (els) => els.map((e) => [e.textContent, e.className]));
  const change = fx.seeded.changes.find((c) => c.path === "notes/plan.md");
  const lines = change.diff.split("\n");
  const same = shown.length === lines.length && shown.every(([t, c], i) => t === lines[i] && c === (lines[i][0] === "+" ? "add" : lines[i][0] === "-" ? "del" : ""));
  check("fileopen", same && (await page.textContent(".dlg h2")) === "notes/plan.md", `the dialog shows the path and the engine's diff line for line (GET /api/state runs[].changes: ${lines.length} lines)`);
  await page.click('.dlg [data-act="dlg-close"]');
  await page.click('#pane [data-act="pane"][data-p="close"]');
}

async function pinRename(page, fx, stamp) {
  await rowMenu(page, fx.seeded.sessionId);
  check("pin-id (plain conversation greyed)", !(await live(page, '.pop [data-act="pin-id-off"]')), "the engine keeps no pin for a plain conversation, so Pin is greyed");
  await page.keyboard.press("Escape");
  await rowMenu(page, fx.a.chatSessionId);
  await page.click('.pop [data-act="pin-id"]');
  const pinned = await until(async () => (await api("trunks")).trunks.find((t) => t.id === fx.a.id)?.pinned === true);
  await page.waitForTimeout(500);
  const under = await page.evaluate((id) => { const row = document.querySelector(`#side .row[data-id="${id}"]`); let h = row?.previousElementSibling; while (h && !h.classList.contains("lh")) h = h.previousElementSibling; return h?.textContent; }, fx.a.chatSessionId);
  check("pin-id (Trunk)", !!pinned && under === "Pinned", "GET /api/trunks shows pinned: true and the row is under Pinned");
  await rowMenu(page, fx.a.chatSessionId);
  const label = await page.textContent('.pop [data-act="pin-id"]');
  await page.click('.pop [data-act="pin-id"]');
  const unpinned = await until(async () => (await api("trunks")).trunks.find((t) => t.id === fx.a.id)?.pinned === false);
  check("pin-id (unpin)", /Unpin/.test(label) && !!unpinned, "the item says Unpin; GET /api/trunks shows pinned: false again");
  await rowMenu(page, fx.room.sessionId);
  await page.click('.pop [data-act="pin-id"]');
  const roomPinned = await until(async () => (await api("trunks")).rooms.find((r) => r.id === fx.room.id)?.pinned === true);
  check("pin-id (room)", !!roomPinned, "POST /api/trunks/rooms/<id>: GET /api/trunks rooms[] shows pinned: true");
  await rowMenu(page, fx.a.chatSessionId);
  await page.click('.pop [data-act="rename-id"]');
  await page.fill("#rn-name", `Renamed ${stamp}`);
  await page.click('[data-act="rename-save"]');
  const renamed = await until(async () => (await api("trunks")).trunks.find((t) => t.id === fx.a.id)?.name === `Renamed ${stamp}`);
  check("rename-id", !!renamed, "GET /api/trunks shows the new name");
}

async function renameMachine(page, kind, id, name) {
  await page.click("#side .machine");
  await page.waitForSelector(`.pop [data-act="renamecomp"][data-k="${kind}"]`);
  await page.click(`.pop [data-act="renamecomp"][data-k="${kind}"]${id ? `[data-id="${id}"]` : ""}`);
  await page.fill("#rc-name", name);
  await page.click('[data-act="rc-save"]');
  await page.waitForTimeout(400);
}
async function machines(page, fx, stamp) {
  await page.click("#side .machine");
  await page.waitForSelector(".pop .mi-t");
  const names = await page.$$eval(".pop .mi-t", (els) => els.map((e) => e.textContent));
  check("machines (list)", names.includes("verify node") && names.includes(fx.device.name), "the switcher lists the node (GET /api/asks/nodes) and the paired device (GET /api/devices)");
  check("machine (greyed)", !(await live(page, '.pop [data-act="machine"]')), "talking to another computer stays greyed");
  await page.keyboard.press("Escape");
  await renameMachine(page, "here", "", `box-${stamp}`);
  const here = (await api("reach")).machineName;
  const side = await page.textContent("#side .mach14 b");
  check("rc-save (this computer)", here === `box-${stamp}` && side === here, "GET /api/reach machineName is the new name, and the list's machine button shows it");
  await renameMachine(page, "node", "verify-node", `Node ${stamp}`);
  const node = (await api("asks/nodes")).nodes[0];
  check("rc-save (other Branch computer)", node.name === `Node ${stamp}` && node.address === "http://127.0.0.1:9" && node.secret === "verify-node-key" && node.labels[0] === "home", "GET /api/asks/nodes: new name, address, key name and labels unchanged");
  await renameMachine(page, "device", fx.device.id, `Phone ${stamp}`);
  const device = (await api("devices")).devices.find((d) => d.id === fx.device.id);
  check("rc-save (paired device)", device?.name === `Phone ${stamp}`, "GET /api/devices shows the new name");
  check("renamecomp", true, "each rename above opened the dialog from the switcher row's pencil");
}

async function keys(page) {
  await page.click("body", { position: { x: 700, y: 400 } }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  await page.waitForSelector('.dlg [data-act="key15"][data-v="palette"]');
  await page.click('.dlg [data-act="key15"][data-v="palette"]');
  await page.waitForSelector(".listen15");
  await page.keyboard.press("p");
  const still = (await api("comfort")).values.keys.palette;
  check("key15 (needs Ctrl or Alt)", still === "Ctrl+K", "a key without Ctrl or Alt is refused; GET /api/comfort keeps Ctrl+K");
  await page.click('.dlg [data-act="key15"][data-v="palette"]');
  await page.keyboard.press("Control+Alt+P");
  const saved = await until(async () => (await api("comfort")).values.keys.palette === "Ctrl+Alt+P");
  check("key15 (saved)", !!saved, "GET /api/comfort values.keys.palette is Ctrl+Alt+P");
  await page.click('.dlg [data-act="dlg-close"]');
  await page.keyboard.press("Control+k");
  const oldKey = await page.isVisible(".palette");
  await page.keyboard.press("Control+Alt+P");
  const newKey = await page.waitForSelector(".palette", { timeout: 3000 }).then(() => true, () => false);
  check("key15 (fires)", !oldKey && newKey, "Ctrl+K no longer opens Find anything; Ctrl+Alt+P does");
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.click('.dlg [data-act="keyreset15"][data-v="palette"]');
  const back = await until(async () => (await api("comfort")).values.keys.palette === "Ctrl+K");
  await page.click('.dlg [data-act="dlg-close"]');
  await page.keyboard.press("Control+k");
  const works = await page.waitForSelector(".palette", { timeout: 3000 }).then(() => true, () => false);
  check("keyreset15", !!back && works, "GET /api/comfort palette is Ctrl+K again, and Ctrl+K opens Find anything");
  await page.keyboard.press("Escape");
}

/* The side panel's key lives in chat/pane.js, which reads the same bindings. */
async function paneKey(page, fx) {
  await page.click(`#side .row[data-id="${fx.seeded.sessionId}"]`);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  await page.click('.dlg [data-act="key15"][data-v="sidePane"]');
  await page.keyboard.press("Control+Alt+J");
  const saved = await until(async () => (await api("comfort")).values.keys.sidePane === "Ctrl+Alt+J");
  await page.click('.dlg [data-act="dlg-close"]');
  const open = () => page.evaluate(() => !document.getElementById("pane")?.hidden);
  const before = await open();
  await page.keyboard.press("Control+Shift+K");
  await page.waitForTimeout(300);
  const oldKey = (await open()) !== before;
  await page.keyboard.press("Control+Alt+J");
  await page.waitForTimeout(300);
  const newKey = (await open()) !== before;
  await page.keyboard.press("Control+Alt+J");
  await page.keyboard.press("?");
  await page.click('.dlg [data-act="keyreset15"][data-v="sidePane"]');
  const back = await until(async () => (await api("comfort")).values.keys.sidePane === "Ctrl+Shift+K");
  await page.click('.dlg [data-act="dlg-close"]');
  check("key15 (side panel)", !!saved && !oldKey && newKey && !!back, "GET /api/comfort sidePane is Ctrl+Alt+J; Ctrl+Shift+K no longer toggles the side panel, Ctrl+Alt+J does; put back to Ctrl+Shift+K");
}

async function ownBackground(page) {
  await page.click('#side [data-act="view"][data-v="settings"]');
  await page.click('[data-act="setpage"][data-v="appearance"]');
  await page.waitForSelector('[data-act="bgset"][data-v="own"]');
  await page.click('[data-act="bgset"][data-v="own"]');
  const on = await until(async () => (await api("delight")).settings.background.on === true);
  await page.waitForSelector("#bg-file6");
  check("bgset own", !!on && (await page.getAttribute('[data-act="bgset"][data-v="own"]', "aria-pressed")) === "true", "GET /api/delight background.on is true; Your own is pressed and offers a file");
  await page.setInputFiles("#bg-file6", { name: "verify-bg.png", mimeType: "image/png", buffer: png(40, 30) });
  await page.waitForSelector("#bgLayer .bg-img", { timeout: 5000 });
  const kept = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open("branch-delight", 1); r.onsuccess = () => { const g = r.result.transaction("files").objectStore("files").get("background"); g.onsuccess = () => { r.result.close(); resolve(g.result ? [g.result.name, g.result.kind] : null); }; }; r.onerror = () => resolve(null); }));
  check("own background (kept)", kept?.[0] === "verify-bg.png" && kept?.[1] === "picture", "the file is in this window's IndexedDB (branch-delight/files/background) and drawn behind the glass");
  const before = (await api("delight")).settings.background;
  await page.click('[data-act="bgfit"][data-v="tile"]');
  const fit = await until(async () => { const b = (await api("delight")).settings.background; return b.fit === "tile" ? b : null; });
  await page.waitForSelector("#bgLayer .bg-img.fit-tile", { timeout: 3000 });
  check("bgfit", !!fit && fit.on === before.on && fit.scrim === before.scrim, "GET /api/delight background.fit is tile, on and scrim unchanged; the picture repeats");
  await page.click('[data-act="bg-remove"]');
  await page.waitForSelector('.dlg [data-act="bg-remove-yes"]');
  check("bg-remove", (await page.textContent(".dlg p")).includes("verify-bg.png"), "the confirm dialog names the file");
  await page.click('.dlg [data-act="bg-remove-yes"]');
  const off = await until(async () => (await api("delight")).settings.background.on === false);
  await page.waitForTimeout(400);
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  check("bg-remove-yes", !!off && !dbs.includes("branch-delight") && !(await page.$("#bgLayer")), "the window's storage for it is gone, GET /api/delight background.on is false, nothing is drawn");
  await page.click(".set-back").catch(() => {});
}

(async () => {
  const stamp = Date.now().toString(36);
  const fx = await fixtures(stamp);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await signIn(page);
    await bgNew(page, stamp);
    await fileOpen(page, fx);
    await pinRename(page, fx, stamp);
    await machines(page, fx, stamp);
    await keys(page);
    await paneKey(page, fx);
    await ownBackground(page);
  } catch (error) {
    check("script", false, error.message.split("\n")[0]);
    await page.screenshot({ path: require("path").join(require("os").tmpdir(), "verify-shell3-failure.png") }).catch(() => {});
  }
  await browser.close();
  console.log("\n| Action | Result | How it was confirmed |\n|---|---|---|");
  for (const [a, r, h] of results) console.log(`| ${a} | ${r} | ${h} |`);
  console.log(`\npage errors: ${errors.length}${errors.length ? "\n" + errors.join("\n") : ""}`);
  process.exit(results.every((r) => r[1] === "PASS") && !errors.length ? 0 : 1);
})();
