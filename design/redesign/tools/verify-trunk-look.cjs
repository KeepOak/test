// Verifies the Trunk editor (Edit Trunk › Look, What it may do, Its computers, Remove Trunk…) in the real window against a
// running engine, with real mouse clicks, and reads every change back from the engine's GET routes. Page errors must be zero.
//   1. Every character in public/art/agents (plus Branch's spirit) has a card with its still; only pass 17's are New.
//      Each one is picked, and GET /api/trunks says the Trunk wears it.
//   2. The pick survives a reload: the card stays chosen, and the sidebar row, the agent beside the conversation and its
//      replies each play the character's loop for what it is doing (core/figures.js; its still when motion is reduced).
//   3. A photo: a PNG is uploaded (GET avatar.kind "image", the preview shows it), a GIF is refused with the engine's
//      words, a file over the limit is refused, the engine refuses an oversize picture itself, and Remove gives the face back.
//   4. Eyes, shape and motion save (GET eyes, look.shape, look.motion) and the sidebar face takes them; an emoji saves.
//   5. What it may do and Its computers: every control is either live and proved, or greyed with a reason listed here.
//   6. The grid scrolls at 1440 and nothing scrolls sideways at 390.
//   7. Remove Trunk… asks first (naming what happens to its room), removes it, and the lists update without a reload.
// Run on a throwaway engine: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-trunk-look.cjs
// It makes its own Trunks and a room, and a model connection answered by a stand-in on 127.0.0.1:1337 for Which model.
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { gselChoices, gselShown, pickGsel } = require("./gsel.cjs");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/trunk-look/";
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
fs.mkdirSync(SHOTS, { recursive: true });

async function call(p, body) {
  const res = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}
async function api(p, body) {
  const r = await call(p, body);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${r.data.error ?? ""}`);
  return r.data;
}
const results = [];
function check(name, ok, how) { results.push([name, ok ? "PASS" : "FAIL", how]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${how ? ` — ${how}` : ""}`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const trunk = async (id) => (await api("trunks")).trunks.find((t) => t.id === id);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/* The characters on disk a Trunk can wear: every folder under public/art/agents with a still. Branch's own figure is not
   one of them: the mascot is the logo only (#654, core/art17.js looks17). */
function onDisk() {
  const dir = path.join(__dirname, "../../../public/art/agents");
  return [...fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "still.webp"))).map((d) => d.name)];
}

/* A stand-in model service where the catalog's "jan" listens, so the engine has a preset to offer Which model. */
function standIn() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ object: "list", data: [{ id: "verify-model", object: "model" }] }));
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
  });
  return new Promise((done) => { server.once("error", () => done(null)); server.listen(1337, "127.0.0.1", () => done(server)); });
}

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForSelector("#side .machine");
  if (await page.isVisible(".ob9")) await page.keyboard.press("Escape"); // Skip shows only after Welcome
}
/* The editor, opened as the owner opens it: Customize › Trunks › Edit. */
async function openEditor(page, id) {
  if (await page.isVisible(".scrim")) { await page.locator('.dlg .dlg-h [data-act="dlg-close"]').click(); await page.waitForSelector(".scrim", { state: "detached" }); }
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator(`.prow [data-act="edit"][data-id="${id}"]`).click();
  await page.waitForSelector(".dlg .editor");
}
const dlg = (page) => page.locator(".dlg");
/* A change is sent, then the window reads the engine again (GET /api/state, /api/trunks, …); wait for that round. */
async function settle(page) {
  await page.waitForResponse((r) => r.url().includes("/api/trunks") && r.request().method() === "GET", { timeout: 4000 }).catch(() => {});
  await wait(300);
}

async function characters(page, id) {
  const disk = onDisk(), cards = await page.$$eval(".dlg .looks-tl .look-c12", (els) => els.map((b) => ({ v: b.dataset.v, isNew: b.classList.contains("new17e"), img: b.querySelector("img")?.getAttribute("src") ?? null })));
  const shown = cards.map((c) => c.v);
  check("every character on disk has a card", disk.every((d) => shown.includes(d)) && shown[0] === "classic", `disk ${disk.length}: ${disk.join(", ")}; cards ${shown.length}`);
  check("only pass 17's characters are marked New", cards.filter((c) => c.isNew).map((c) => c.v).sort().join() === "nib,skein,sorrel", cards.filter((c) => c.isNew).map((c) => c.v).join(", "));
  const loaded = await page.$$eval(".dlg .looks-tl .look-c12 img", async (imgs) => { await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))); return imgs.map((i) => [i.closest("button").dataset.v, i.naturalWidth > 0]); });
  check("every card's still loads", loaded.every(([, ok]) => ok), loaded.filter(([, ok]) => !ok).map(([v]) => v).join(", ") || `${loaded.length} stills`);
  for (const v of disk) {
    const card = page.locator(`.dlg .look-c12[data-v="${v}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await settle(page);
    const got = (await trunk(id)).character;
    const pressed = await page.getAttribute(`.dlg .look-c12[data-v="${v}"]`, "aria-pressed");
    check(`pick ${v}`, got === v && pressed === "true", `GET character=${got}, card aria-pressed=${pressed}`);
  }
}

/* A character's face plays its loop (core/figures.js): a video with the still as its poster, the loop for the state it acts
   out (else idle), at one of its smaller sizes. faces: [state, tagName, poster, src]. */
const loopOf = (c, st, src) => new RegExp(`^${(c.states[st] ?? c.states.idle).replace(/[.]webm$/, "")}([.][0-9]+)?[.]webm$`).test(src ?? "");
const plays = (c, faces) => faces.length > 0 && faces.every(([st, tag, poster, src]) => tag === "VIDEO" && poster === c.still && loopOf(c, st, src));
const facesIn = (page, sel) => page.$$eval(sel, (els) => els.map((v) => [v.closest("[data-st]")?.dataset.st, v.tagName, v.getAttribute("poster"), v.getAttribute("src")]));

async function persists(browser, page, id, sid) {
  await page.locator('.dlg .look-c12[data-v="kite"]').scrollIntoViewIfNeeded();
  await page.locator('.dlg .look-c12[data-v="kite"]').click();
  await settle(page);
  await page.reload();
  await page.waitForSelector("#side .machine");
  const kite = (await api("trunks")).characters.find((c) => c.id === "kite");
  await page.waitForSelector(`#side .row[data-id="${sid}"] .av.look12 .fig12`, { timeout: 8000 }).catch(() => {});
  const row = await facesIn(page, `#side .row[data-id="${sid}"] .av.look12 .fig12`);
  check("the sidebar row plays the chosen character after a reload", plays(kite, row), JSON.stringify(row));
  await openEditor(page, id);
  check("the pick survives a reload", (await page.getAttribute('.dlg .look-c12[data-v="kite"]', "aria-pressed")) === "true" && (await trunk(id)).character === "kite", "card chosen, GET character=kite");
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator(`#side .row[data-id="${sid}"]`).click();
  await page.waitForSelector(".ag-one12 .fig12", { timeout: 15000 }).catch(() => {});
  /* It acts out what the Trunk is doing (chat/agent17.js agentState): that state's loop, else its idle loop. */
  const fig = await page.$eval(".ag-one12", (el) => [el.dataset.st, el.querySelector(".fig12").tagName, el.querySelector(".fig12").getAttribute("poster"), el.querySelector(".fig12").getAttribute("src")]).catch(() => null);
  check("the agent beside the conversation plays the loop for its state", !!fig && plays(kite, [fig]), JSON.stringify(fig));
  await page.waitForSelector("#main .gut .av .fig12", { timeout: 5000 }).catch(() => {});
  const faces = await facesIn(page, "#main .gut .av .fig12");
  check("its replies in the conversation play the character", plays(kite, faces), JSON.stringify(faces));
  const calm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await signIn(calm);
  await calm.locator(`#side .row[data-id="${sid}"]`).click();
  await calm.waitForSelector(".ag-one12 .fig12", { timeout: 5000 }).catch(() => {});
  const still = await calm.$eval(".ag-one12 .fig12", (el) => [el.tagName, el.getAttribute("src")]).catch(() => null);
  check("with reduced motion it is the still", still?.[0] === "IMG" && still[1] === "/art/agents/kite/still.webp", JSON.stringify(still));
  await calm.close();
  await page.screenshot({ path: SHOTS + "agent-beside-kite.png" });
}

async function choose(page, name, buffer, mimeType, refused = false) {
  await page.evaluate(() => document.querySelector(".toast")?.remove());
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator('.dlg [data-act="st-photo"]').click()]);
  await chooser.setFiles({ name, mimeType, buffer });
  if (!refused) return settle(page);
  return page.locator(".toast").innerText({ timeout: 4000 }).catch(() => "");
}
async function photo(page, id) {
  await page.locator('.dlg .look-c12[data-v="classic"]').click();
  await settle(page);
  check("the photo control is a live button, not a greyed file field", (await page.locator('.dlg [data-act="st-photo"]:not(.soon)').count()) === 1 && (await page.locator('.dlg input[type="file"]').count()) === 0, "");
  await choose(page, "face.png", PNG, "image/png");
  const a = (await trunk(id)).avatar;
  check("a PNG uploads through POST /api/trunks/{id}/avatar", a?.kind === "image" && a.dataUrl.startsWith("data:image/png;base64,"), `GET avatar.kind=${a?.kind}`);
  check("the preview and a Remove control show", (await page.locator(".dlg .editor .big .av.photo-tl img").count()) === 1 && (await page.locator('.dlg [data-act="st-photo-x"]').count()) === 1, "");
  await page.locator(".dlg").screenshot({ path: SHOTS + "photo-uploaded.png" });
  const gifToast = await choose(page, "face.gif", GIF, "image/gif", true);
  check("a GIF is refused with the engine's words", /PNG, JPEG or WebP/.test(gifToast) && (await trunk(id)).avatar?.dataUrl?.startsWith("data:image/png"), `toast "${gifToast}"`);
  const bigToast = await choose(page, "huge.png", Buffer.alloc(300 * 1024, 1), "image/png", true);
  check("a picture over the limit is refused", /290 KB/.test(bigToast), `toast "${bigToast}"`);
  const engine = await call(`trunks/${id}/avatar`, { kind: "image", dataUrl: "data:image/png;base64," + "A".repeat(400_000) });
  check("the engine refuses an oversize picture itself", engine.status === 400 && /too large/.test(engine.data.error ?? ""), `${engine.status} ${engine.data.error}`);
  await page.locator('.dlg [data-act="st-photo-x"]').click();
  await settle(page);
  check("Remove gives the face made from the name back", (await trunk(id)).avatar?.kind === "face" && (await page.locator(".dlg .editor .big .av.photo-tl").count()) === 0, `GET avatar.kind=${(await trunk(id)).avatar?.kind}`);
}

async function draftsSave(page, id, sid) {
  await page.locator('.dlg [data-act="st-eyes"][data-v="wide"]').click();
  check("eyes update the preview", (await page.locator(".dlg .editor .big .av.wide").count()) === 1, "");
  await page.locator('.dlg [data-act="st-shape"][data-v="2"]').click();
  await page.locator('.dlg [data-act="st-anim"][data-v="sway"]').click();
  /* A face over 24px is the 3D pebble (core/pebble.js), drawn from the rendered shape it names; a flat one by its radius. */
  const radii = await page.$$eval(".dlg .shapes .av", (els) => els.map((e) => e.dataset.pblShape ?? getComputedStyle(e.querySelector(".peb")).borderRadius));
  check("the five shapes are drawn as five different shapes", new Set(radii).size === 5, radii.join(" | "));
  await page.locator(".dlg").screenshot({ path: SHOTS + "look-drafts.png" });
  await page.locator('.dlg [data-act="st-save"]').click();
  await settle(page);
  const t = await trunk(id);
  check("eyes save", t.eyes === "wide", `GET eyes=${t.eyes}`);
  check("shape saves", t.look?.shape === "leaf", `GET look.shape=${t.look?.shape}`);
  check("motion saves (Bob is the engine's sway)", t.look?.motion === "sway", `GET look.motion=${t.look?.motion}`);
  const cls = await page.getAttribute(`#side .row[data-id="${sid}"] .av`, "class");
  check("the sidebar face takes the eyes and the motion", /\bwide\b/.test(cls ?? "") && /\banim-bob\b/.test(cls ?? ""), `class="${cls}"`);
  await openEditor(page, id);
  await page.locator('.dlg [data-act="st-anim"][data-v="breathe"]').click();
  await page.locator('.dlg [data-act="st-save"]').click();
  await settle(page);
  check("Breathe saves", (await trunk(id)).look?.motion === "breathe", "");
  await openEditor(page, id);
  await page.locator('.dlg [data-act="emo15"][data-v="🦊"]').click();
  await settle(page);
  const e = await trunk(id);
  check("an emoji face saves at once", e.look?.face === "emoji" && e.look.emoji === "🦊" && (await page.locator(".dlg .editor .big .av.emoji15").count()) === 1, `GET look.face=${e.look?.face} emoji=${e.look?.emoji}`);
  await page.locator('.dlg [data-act="emo15"][data-v=""]').click();
  await settle(page);
  check("None gives the pattern back", (await trunk(id)).look?.face === "pattern", "");
}

/* Every control of a tab: live ones are clicked for real; greyed ones must be on the list below, with the reason. */
const GREYED = {
  may: { "sw:tm-read": "loosens what the Trunk may do (security review)", "sw:tm-browse": "loosens what the Trunk may do (security review)", "seg:Ask first": "Send without asking loosens approvals (security review)", "seg:Allowed": "Send without asking loosens approvals (security review)", "seg:Never": "the engine's Spend money category holds no tool in this build (GET /api/state approvalCategories)", "sw:tm-notes": "a Trunk's notes are always its own; the engine has no switch for it" },
  its17d: { "itsmax17d:2": "the engine refuses more at once than computers allowed (src/trunks/computers.ts)", "itsmax17d:3": "same", "itsmax17d:4": "same", "cloudnew17d:": "no cloud computer provider in this build" },
};
async function tabControls(page, tab) {
  await page.locator(`.dlg [data-act="st-tab"][data-v="${tab}"]`).click();
  await wait(600);
  const list = await page.$$eval(".dlg .dlg-b button, .dlg .dlg-b input", (els) => els.filter((e) => !e.closest(".tabs, .big")).map((e) => ({ key: e.dataset.act === "seg" ? `seg:${e.textContent.trim()}` : e.tagName === "INPUT" && e.id ? `sw:${e.id}` : `${e.dataset.act || e.dataset.sw}:${e.dataset.v ?? ""}`, grey: e.disabled || e.getAttribute("aria-disabled") === "true" })));
  const unexplained = list.filter((c) => c.grey && !GREYED[tab][c.key]).map((c) => c.key);
  check(`${tab}: no greyed control without a reason`, unexplained.length === 0, unexplained.join(", ") || `greyed: ${list.filter((c) => c.grey).map((c) => `${c.key} (${GREYED[tab][c.key]})`).join("; ") || "none"}`);
  await page.locator(".dlg").screenshot({ path: SHOTS + `tab-${tab}.png` });
  return list;
}
async function otherTabs(page, id, preset) {
  await tabControls(page, "may");
  const spend = (await api("state")).approvalCategories?.find((c) => c.id === "spend");
  check("Spend money is greyed because the engine has no spending tool", spend && spend.tools.length === 0, `GET /api/state approvalCategories spend.tools=${JSON.stringify(spend?.tools)}`);
  if (preset) {
    // Stress test: Which model is the window's own dropdown (core/gsel.js); Default ("") follows the conversation's model.
    await pickGsel(page.locator(".dlg #tm-model-sel"), preset);
    await settle(page);
    check("Which model saves the engine's preset", (await trunk(id)).model === preset && (await gselShown(page.locator(".dlg #tm-model-sel"))).value === preset, `GET model=${(await trunk(id)).model}`);
    await pickGsel(page.locator(".dlg #tm-model-sel"), "");
    await settle(page);
    check("Default gives it back to the conversation's model", (await trunk(id)).model === "", "");
  } else check("Which model", false, "no model preset: the stand-in on 127.0.0.1:1337 could not start");
  await tabControls(page, "its17d");
  const box = page.locator('.dlg input[data-sw="itsc17d"]').first();
  const cid = await box.getAttribute("data-v");
  await box.uncheck();
  await settle(page);
  const off = await api(`trunks/${id}/computers`);
  await page.locator(`.dlg input[data-sw="itsc17d"][data-v="${cid}"]`).check();
  await settle(page);
  const on = await api(`trunks/${id}/computers`);
  check("Its computers: a computer switches off and on", !off.allowed?.includes(cid) && on.allowed?.includes(cid), `allowed off=${JSON.stringify(off.allowed)} on=${JSON.stringify(on.allowed)}`);
  await page.locator('.dlg [data-act="itsmax17d"][data-v="1"]').click();
  await settle(page);
  check("Its computers: one at once saves", (await api(`trunks/${id}/computers`)).atOnce === 1, "");
  await page.locator(`.dlg [data-act="itsfirst17d"][data-v="${cid}"]`).click();
  await settle(page);
  check("Its computers: starts on answers", (await page.getAttribute(`.dlg [data-act="itsfirst17d"][data-v="${cid}"]`, "aria-pressed")) === "true", "");
}

async function layout(page) {
  await page.locator('.dlg [data-act="st-tab"][data-v="look"]').click();
  await wait(400);
  const at1440 = await page.$eval(".dlg .looks-tl", (g) => ({ scrolls: g.scrollHeight > g.clientHeight, style: getComputedStyle(g).overflowY, sideways: document.documentElement.scrollWidth > innerWidth }));
  check("1440: the characters are a scrolling grid", at1440.scrolls && at1440.style === "auto" && !at1440.sideways, JSON.stringify(at1440));
  await page.locator(".dlg").screenshot({ path: SHOTS + "look-1440.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(500);
  const at390 = await page.$eval(".dlg", (d) => ({ width: Math.round(d.getBoundingClientRect().width), page: document.documentElement.scrollWidth, dialog: d.querySelector(".dlg-b").scrollWidth - d.querySelector(".dlg-b").clientWidth }));
  check("390: nothing scrolls sideways", at390.width <= 390 && at390.page <= 390 && at390.dialog <= 1, JSON.stringify(at390));
  await page.screenshot({ path: SHOTS + "look-390.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(300);
}

async function removal(page, id, sid, room) {
  await page.locator('.dlg [data-act="remove"]').click();
  await page.waitForSelector(".dlg .rm-list-tl");
  const text = await page.locator(".dlg .rm-list-tl").innerText();
  check("Remove Trunk… asks first, naming its room", text.includes(room.name) && /automations/i.test(text), text.replace(/\n/g, " / "));
  await page.locator(".dlg").screenshot({ path: SHOTS + "remove-confirm.png" });
  await page.locator('.dlg [data-act="trunk-remove-yes"]').click();
  await settle(page);
  const all = await api("trunks");
  check("the engine removed it", !all.trunks.some((t) => t.id === id), "GET /api/trunks");
  check("its room of two is removed, as the dialog said", !all.rooms.some((r) => r.id === room.id), "");
  check("the Trunks list updates without a reload", (await page.locator(`.prow [data-act="edit"][data-id="${id}"]`).count()) === 0, "Customize › Trunks row gone");
  /* Both conversations have no Trunk now, so each row draws the face of a conversation with no Trunk (core/ui.js av):
     never the room's stack of faces, the Trunk's pebble, emoji or photo, nor any character (the mascot is the logo only). */
  const side = await page.evaluate(([r, s]) => [r, s].map((id) => { const f = document.querySelector(`#side .row[data-id="${id}"] .avw`); return { stack: !!f?.querySelector(".stack"), own: !!f?.querySelector(".pbl, .emoji15, .photo-tl"), still: f?.querySelector("[data-m17]")?.dataset.m17 ?? null }; }), [room.sessionId, sid]);
  check("the sidebar updates without a reload", side.every((f) => !f.stack && !f.own && !f.still),
    `the room's conversation no longer draws the room's faces and the Trunk's no longer wears its face; neither draws a character: ${JSON.stringify(side)}`);
  const kept = await call(`sessions/${sid}`);
  check("its conversation stays, as the dialog said", kept.ok && kept.data.sessionId === sid, `GET /api/sessions/{id} ${kept.status}`);
  const memory = (await api("memory/export")).records ?? [];
  check("what it remembered stays, as the dialog said", memory.some((r) => r.data?.scope === `agent:trunk:${id}`), "GET /api/memory/export");
}

(async () => {
  const stamp = Date.now().toString(36);
  const { trunk: tr } = await api("trunks", { name: `Look ${stamp}` });
  const { trunk: mate } = await api("trunks", { name: `Mate ${stamp}` });
  const { room } = await api("trunks/rooms", { name: `Room ${stamp}`, members: [tr.id, mate.id], rule: "mention" });
  const now = new Date().toISOString();
  await api("memory/import", { format: "branch-agent-memory", version: 1, exportedAt: now, records: [{ id: `verify-${stamp}`, data: { text: "Prefers short answers", source: "verify-trunk-look", scope: `agent:trunk:${tr.id}` }, createdAt: now, updatedAt: now, revision: 1 }] });
  const server = await standIn();
  let preset = null;
  if (server) {
    const made = await call("connections/from-preset", { provider: "jan", key: "verify-test-key", model: "verify-model", name: `Verify ${stamp}` });
    preset = made.ok ? made.data.id : null;
    if (!made.ok) console.log(`stand-in connection refused: ${made.status} ${made.data.error}`);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    await openEditor(page, tr.id);
    await page.locator(".dlg").screenshot({ path: SHOTS + "look-open.png" });
    await characters(page, tr.id);
    await persists(browser, page, tr.id, tr.chatSessionId);
    await openEditor(page, tr.id);
    await photo(page, tr.id);
    await draftsSave(page, tr.id, tr.chatSessionId);
    await openEditor(page, tr.id);
    await otherTabs(page, tr.id, preset);
    await layout(page);
    await removal(page, tr.id, tr.chatSessionId, room);
  } catch (error) {
    check("script ran to the end", false, error.message);
    await page.screenshot({ path: SHOTS + "failure.png" }).catch(() => {});
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  server?.close();
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
