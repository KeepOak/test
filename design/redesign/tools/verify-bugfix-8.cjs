/* Bugfix 8 (the window bugs the ported Trunk tests in PR #348 found): proves each fix in the real window against a
   FRESH engine, reading every change back through the engine's own GET route. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-8.cjs
   A room that needs you (F) needs a Trunk that writes "@you", so that check runs on a second, in-process engine with a
   scripted model (its own temp folder, a free port). Test data it makes through the engine: Trunks "Scout" (an emoji
   face, a chosen colour and a shape) and "Plain" (nothing chosen), a household person "Amara" (never switched to) and a
   room "Trip" made from the + menu's New group chat. Nothing launches a desktop window. */
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(200); } }

/* The prototype's eight colours and five shapes (prototype.html COLOURS, SHAPES). */
const COLOURS = ["#2f8c86", "#d8612a", "#8a5aa8", "#5e8c4a", "#4f6fa8", "#c9982e", "#b84a6b", "#56616b"];
const SHAPES = ["50%", "58% 42% 54% 46% / 52% 56% 44% 48%", "46% 54% 42% 58% / 60% 44% 56% 40%", "62% 38% 50% 50% / 45% 55% 45% 55%", "42% 58% 58% 42% / 50% 42% 58% 50%"];
const INTRO = "Introduce yourself to the owner";

function client(base, token) {
  return async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
}
const BASE = `http://127.0.0.1:${PORT}`;
const api = client(BASE, TOKEN);

async function signIn(context, base, token, call) {
  await call("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  return { page, errors };
}
/* Read again if a redraw replaced the face while it was read (a detached node has no computed style). */
const faceOf = (page, selector) => until(() => page.locator(selector).first().evaluate((node) => ({
  emoji: node.querySelector("i")?.textContent ?? "", colour: node.style.getPropertyValue("--c").toLowerCase(),
  shape: node.style.getPropertyValue("--r").trim(), brand: node.classList.contains("brand"),
  painted: getComputedStyle(node.querySelector(".peb") ?? node).borderRadius })).then((f) => (f.painted ? f : null)), 5000);
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true" && (await loc.evaluate((n) => n.classList.contains("soon")));
async function place(page, name) {
  await page.locator(`#side .nav[data-v="${name}"]`).click();
  await page.locator("#main .place h1").first().waitFor();
}

/* A, B, C, D: one Trunk with an emoji, a chosen colour and a shape; one with nothing chosen. */
async function faces(page) {
  const scout = (await api("trunks", { name: "Scout", title: "Watches prices", description: "" })).trunk;
  const plain = (await api("trunks", { name: "Plain", title: "", description: "" })).trunk;
  await api(`trunks/${scout.id}`, { chosenColour: "#b84a6b", look: { face: "emoji", letters: "", emoji: "🦉", shuffle: 0, colour: null, shape: "shield", motion: "none", depth: "flat" } });
  const got = (await api("trunks")).trunks.find((t) => t.id === scout.id);
  check("setup: the engine keeps Scout's emoji, colour and shape (GET /api/trunks)", got.look?.emoji === "🦉" && got.chosenColour === "#b84a6b" && got.look?.shape === "shield");
  await until(async () => (await api(`sessions/${scout.chatSessionId}`)).messages.some((m) => m.role === "assistant" && !m.toolCalls?.length), 20000);
  await page.reload();
  await page.locator(`#side .row[data-id="${scout.chatSessionId}"] .av`).waitFor({ timeout: 20000 });

  const row = await faceOf(page, `#side .row[data-id="${scout.chatSessionId}"] .av`);
  check("A the sidebar row draws Scout's chosen emoji and colour", row.emoji === "🦉" && row.colour === "#b84a6b", JSON.stringify(row));
  check("B the sidebar row draws Scout's shape (shield, the prototype's fifth)", row.shape === SHAPES[4], row.shape);
  await place(page, "customize");
  await page.locator('.tab[data-act="ptab"][data-place="customize"][data-v="trunks"]').click();
  await page.locator('#main .prow:has(b:text-is("Scout")) .av').waitFor();
  const card = await faceOf(page, '#main .prow:has(b:text-is("Scout")) .av');
  check("A/B Customize › Trunks draws the same face as the row", card.emoji === row.emoji && card.colour === row.colour && card.shape === row.shape, JSON.stringify(card));

  const jobs = await page.locator("#main .tile .th .av").evaluateAll((nodes) => nodes.map((n) => n.style.getPropertyValue("--r").trim()));
  check("B Start from a job draws each job in the prototype's shape for it (templates: 0, 2, 1, 3, 4, 3)", JSON.stringify(jobs) === JSON.stringify([0, 2, 1, 3, 4, 3].map((i) => SHAPES[i])), JSON.stringify(jobs));

  const bare = await faceOf(page, `#side .row[data-id="${plain.chatSessionId}"] .av`);
  const plainGot = (await api("trunks")).trunks.find((t) => t.id === plain.id);
  check("C a Trunk with no chosen colour (GET: chosenColour empty) is drawn in one of the eight colours, not #2f6f5e", !plainGot.chosenColour && COLOURS.includes(bare.colour), bare.colour);
  check("B/C and in one of the five shapes, so its face is not square", SHAPES.includes(bare.shape) && bare.painted === bare.shape, `${bare.shape} / ${bare.painted}`);

  /* D: its own conversation. */
  await page.locator(`#side .row[data-id="${scout.chatSessionId}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", scout.chatSessionId);
  await page.locator("#conversation .b").first().waitFor({ timeout: 15000 });
  const rowName = await page.locator(`#side .row[data-id="${scout.chatSessionId}"] .ellip14`).innerText();
  const header = await page.locator(".head .who b:visible").first().innerText();
  const opening = (await api("sessions")).sessions.find((s) => s.sessionId === scout.chatSessionId)?.opening ?? "";
  check("D the row is named for the Trunk, not its first message (GET /api/sessions opening is the engine's prompt)", rowName === "Scout" && opening.startsWith(INTRO), rowName);
  check("D the conversation header is named for the Trunk", header === "Scout", header);
  const head = await faceOf(page, ".head:visible .av");
  check("D the header draws the Trunk's face, not Branch's", !head.brand && head.emoji === "🦉", JSON.stringify(head));
  const first = (await api(`sessions/${scout.chatSessionId}`)).messages[0];
  const userLines = await page.locator("#conversation .u").allInnerTexts();
  check("D the engine's introduce-yourself prompt (GET /api/sessions/<id> message 1) is not drawn as the owner's message", first.role === "user" && first.content.startsWith(INTRO) && !userLines.some((t) => t.includes(INTRO)), `${userLines.length} owner messages drawn`);
  const reply = await faceOf(page, "#conversation .b .gut .av");
  check("A the Trunk's reply is signed with its own face", !reply.brand && reply.emoji === "🦉" && reply.colour === "#b84a6b" && reply.shape === SHAPES[4], JSON.stringify(reply));

  /* D in the side search: the Trunk's conversation is found and shown by its name. */
  await page.locator("#side-q").fill("Scout");
  const found = page.locator(`#side .sr-row[data-id="${scout.chatSessionId}"] b`).first();
  await found.waitFor({ timeout: 10000 });
  const foundName = await found.innerText();
  check("D side search shows the Trunk's conversation by the Trunk's name", foundName === "Scout", foundName);
  await page.locator('#side [data-act="sq-clear"]').click();
}

/* E: Overview's Who is using Branch lists everyone (GET /api/profiles); switching stays greyed. */
async function everyone(page) {
  await api("profiles", { name: "Amara", pin: "4321" });
  const profiles = await api("profiles");
  const want = [profiles.roleLabels.owner.label, ...profiles.profiles.map((p) => p.name)];
  await page.reload();
  await page.locator("#prompt").waitFor();
  await page.waitForTimeout(800);
  await place(page, "overview");
  const tile = page.locator("#main .tile").filter({ has: page.getByRole("heading", { name: "Who is using Branch" }) });
  await tile.waitFor();
  const names = await tile.locator(".me + span").allInnerTexts();
  check("E the tile lists everyone GET /api/profiles has, in order", JSON.stringify(names) === JSON.stringify(want), JSON.stringify(names));
  check("E the person here now is marked Here now", (await tile.innerText()).split("Here now").length === 2);
  await page.locator('#side [data-act="owner"]').click();
  const others = page.locator('.pop [data-act="switchto"]');
  // unhold/people: switching person is live now (it asks for the PIN; proved in verify-unhold-people.cjs), so this only
  // checks it is not greyed and that opening the menu switched nobody.
  check("E switching person is live", !(await greyed(others.first()))); // your-profile: your own tile opens Your profile instead
  await page.keyboard.press("Escape");
  check("E nobody was switched to (GET /api/profiles isOwner)", (await api("profiles")).isOwner === true);
}

/* The + menu: New room and New group chat open the room dialog, which makes the room (POST /api/trunks/rooms). */
async function plusMenu(page) {
  await page.locator('#side [data-act="newmenu"]').click();
  const menu = page.locator(".pop");
  const room = menu.getByRole("menuitem", { name: "New room" });
  const group = menu.getByRole("menuitem", { name: /New group chat/ });
  check("+ menu has New room and New group chat, neither greyed", (await room.count()) === 1 && (await group.count()) === 1 && !(await greyed(room)) && !(await greyed(group)));
  const order = await menu.locator(".mi-t").allInnerTexts();
  check("+ menu keeps the prototype's order (New automation before New group chat)", order.indexOf("New automation") < order.indexOf("New group chat") && order.indexOf("New room") < order.indexOf("New automation"), JSON.stringify(order));
  await room.click();
  const dlg = page.locator(".dlg");
  await dlg.getByRole("heading", { name: "New group chat" }).waitFor();
  check("New room opens the room dialog", true);
  await dlg.locator('.dlg-f [data-act="dlg-close"]').click();
  await dlg.waitFor({ state: "detached" });
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator(".pop").getByRole("menuitem", { name: /New group chat/ }).click();
  await dlg.getByRole("heading", { name: "New group chat" }).waitFor();
  await dlg.locator("#grp-name").fill("Trip");
  await dlg.locator('[data-act="grp-pick"]').filter({ hasText: "Scout" }).click();
  await dlg.locator('[data-act="grp-pick"]').filter({ hasText: "Plain" }).click();
  await dlg.getByRole("button", { name: "Start the group chat" }).click();
  await dlg.waitFor({ state: "detached", timeout: 15000 });
  const made = await until(async () => (await api("trunks")).rooms?.find((r) => r.name === "Trip"), 10000);
  check("New group chat made the room (GET /api/trunks rooms)", made && made.members.length === 2, made ? made.id : "none");
  if (made) {
    const opened = await until(() => page.evaluate((sid) => document.querySelector(`#side .row[data-id="${sid}"]`)?.getAttribute("aria-current") === "true", made.sessionId), 10000);
    const name = opened ? await page.locator(`#side .row[data-id="${made.sessionId}"] .ellip14`).innerText() : "";
    check("the new room opens, its row named for the room", opened && name === "Trip", name);
  }
}

/* Add a computer or phone: the prototype's note. unhold-pairing: pairing is live now (verify-unhold-pairing.cjs covers it). */
async function pairing(page) {
  await page.locator('#side [data-act="machines"]').click();
  await page.locator('.pop [data-act="addcomp"]').click();
  const dlg = page.locator(".dlg");
  await dlg.getByRole("heading", { name: "Add a computer or phone" }).waitFor();
  const note = await dlg.locator(".status").innerText();
  check("Add a computer or phone shows What happens after pairing", note.includes("What happens after pairing") && note.includes("Unpair any time from Settings › Computer."));
  await dlg.locator('.tab[data-v="phone"]').click();
  await page.waitForFunction(() => document.querySelector('.dlg .tab[data-v="phone"]')?.getAttribute("aria-selected") === "true");
  check("the note stays on every tab, and the phone code opens pairing", (await dlg.locator(".status").count()) === 1 && !(await greyed(dlg.getByRole("button", { name: "Show the phone code" }))));
  await dlg.locator('.dlg-h [data-act="dlg-close"]').click();
  const devices = await api("devices");
  check("nothing was paired (GET /api/devices)", (devices.devices ?? []).length === 0);
}

/* F, on an engine whose Trunk writes "@you" in a room: the room's row is marked (GET /api/trunks rooms[].needsYou). */
async function roomNeedsYou(browser) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-bugfix-8-"));
  const provider = { name: "scripted", async complete(request) {
    const text = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    if (text.startsWith("[Room") && /\nYou are Ada \(@ada\)/.test(system)) return { content: "I can do it. @you which day?", toolCalls: [] };
    if (text.startsWith("[Room")) return { content: "(pass)", toolCalls: [] };
    return { content: "Hello.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call = client(base, server.token);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, base, server.token, call);
  try {
    const ada = (await call("trunks", { name: "Ada", title: "", description: "" })).trunk;
    const bo = (await call("trunks", { name: "Bo", title: "", description: "" })).trunk;
    await app.trunks.introduced();
    const { room } = await call("trunks/rooms", { name: "Weekend", members: [ada.id, bo.id] });
    await page.reload();
    const row = page.locator(`#side .row[data-id="${room.sessionId}"]`);
    await row.waitFor({ timeout: 20000 });
    check("F before anyone asks, the room's row is not marked", (await row.locator("p.attn").count()) === 0 && !(await call("trunks")).rooms.find((r) => r.id === room.id).needsYou);
    await row.click();
    await until(() => page.evaluate(async () => (await import("/app/chat/plus.js")).whoHere()?.kind === "room"), 10000);
    await page.locator("#prompt").fill("Where shall we go?");
    await page.locator("#prompt").press("Enter");
    const needs = await until(async () => (await call("trunks")).rooms.find((r) => r.id === room.id)?.needsYou, 30000);
    check("F the engine says the room needs you (GET /api/trunks rooms[].needsYou)", needs === true);
    const marked = await until(async () => (await row.locator("p.attn").count()) === 1, 15000);
    check("F the room's row is marked as waiting (the prototype's p.attn)", marked);
  } catch (e) { check("scripted engine checks finished", false, e.stack); }
  check("no page errors (scripted engine)", errors.length === 0, errors.join(" | "));
  await context.close();
  await server.close().catch(() => {});
  await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, BASE, TOKEN, api);
  try {
    await faces(page);
    await everyone(page);
    await plusMenu(page);
    await pairing(page);
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await roomNeedsYou(browser);
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
