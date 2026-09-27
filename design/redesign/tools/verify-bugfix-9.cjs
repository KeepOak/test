/* Bugfix 9: proves each fix in the real window against a FRESH engine, reading every change back through the engine's own
   GET routes. Page errors must be zero.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-bugfix-9.cjs
   1 the Trunk intro is hidden by the engine's marker (system: "trunk-intro"), old unmarked conversations by the old words;
   2 the beside picker and the command palette name a Trunk's conversation for the Trunk;
   3 the + menu's "A Trunk from a job…" and "Have Branch make a Trunk" (a real task; the proposal card and Make run on a
     second, in-process engine with a scripted model that answers with the trunk.propose tool: its own temp folder, a
     free port);
   4 a room is drawn as a stack of two member faces;
   5 the demo language taken out is not served;
   6 after a reload the "New to Branch?" card stays clear of the message box and Send (wide and phone-sized).
   Test data it makes through the engine: Trunks "Scout" (a chosen colour) and "Plain", the job Trunk "Inbox Manager",
   a room "Pair", and on the scripted engine "Quill" (made), "Wren" (declined) and "Moss" (Change it first). Nothing launches a desktop window. */
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

/* The words the engine used before the marker existed (src/trunks/index.ts introPrompt). */
const OLD_INTRO = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
const INTRO = "Introduce yourself";

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
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true" && (await loc.evaluate((n) => n.classList.contains("soon")));
const replied = (call, sid) => until(async () => (await call(`sessions/${sid}`)).messages.some((m) => m.role === "assistant" && !m.toolCalls?.length), 30000);
const idle = (call, sid) => until(async () => !((await call("state")).runs ?? []).some((r) => r.sessionId === sid && ["running", "queued"].includes(r.status)), 30000);
async function openRow(page, sid) {
  await page.locator(`#side .row[data-id="${sid}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", sid);
  await page.waitForTimeout(600);
}
const ownLines = (page) => page.locator("#conversation .u").allInnerTexts();

/* 1: the intro, hidden by the marker; an old unmarked one by its old words; the owner's own words always drawn. */
async function intro(page, scout, plain) {
  const first = (await api(`sessions/${scout.chatSessionId}`)).messages.find((m) => m.role === "user");
  check("1 the engine marks the intro ask it saved (GET /api/sessions/<id> first message system: trunk-intro)", first?.system === "trunk-intro", JSON.stringify({ system: first?.system }));
  await openRow(page, scout.chatSessionId);
  check("1 the marked ask is not drawn as the owner's message", !(await ownLines(page)).some((t) => t.includes(INTRO)));

  /* The engine rewords its ask: the window reads the marker, not the words. */
  const route = `**/api/sessions/${scout.chatSessionId}`;
  let rewritten = 0;
  await page.route(route, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    for (const m of body.messages ?? []) if (m.system === "trunk-intro") { m.content = "Please say hello to the owner, in new words."; rewritten++; }
    await r.fulfill({ response: res, json: body });
  });
  await openRow(page, plain.chatSessionId);
  await openRow(page, scout.chatSessionId);
  const reworded = await ownLines(page);
  check("1 a reworded engine ask is still hidden (the marker decides, not the words)", rewritten > 0 && !reworded.some((t) => t.includes("in new words")), `${rewritten} answers reworded; drawn ${JSON.stringify(reworded)}`);
  await page.unroute(route);

  /* A conversation from before the marker: the old words, unmarked, then a message of the owner's own. */
  await idle(api, plain.chatSessionId);
  await api("run", { prompt: OLD_INTRO, sessionId: plain.chatSessionId });
  await idle(api, plain.chatSessionId);
  await api("run", { prompt: "What can you do?", sessionId: plain.chatSessionId });
  await idle(api, plain.chatSessionId);
  const users = (await api(`sessions/${plain.chatSessionId}`)).messages.filter((m) => m.role === "user");
  const old = users.filter((m) => m.content === OLD_INTRO && !m.system);
  check("1 setup: an unmarked message with the old words is in the conversation (GET)", old.length === 1, `${users.length} user messages`);
  await page.reload();
  await page.locator("#prompt").waitFor();
  await openRow(page, plain.chatSessionId);
  const lines = await ownLines(page);
  check("1 an old unmarked intro (the old words, no marker) is hidden too", !lines.some((t) => t.includes(INTRO)), JSON.stringify(lines));
  check("1 the owner's own message is drawn", lines.some((t) => t.includes("What can you do?")), JSON.stringify(lines));
}

/* 2: the beside picker and the command palette name a Trunk's conversation for the Trunk. */
async function titles(page, scout, other) {
  const opening = (await api("sessions")).sessions.find((s) => s.sessionId === scout.chatSessionId)?.opening ?? "";
  check("2 setup: the engine's opening of Scout's conversation is its intro ask (GET /api/sessions)", opening.startsWith(INTRO), opening.slice(0, 40));
  await openRow(page, other);
  await page.locator('.head:visible [data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="beside15"]').first().click();
  const pick = page.locator(`.pop [data-act="beside15"][data-v="${scout.chatSessionId}"] .mi-t`);
  await pick.waitFor();
  const all = await page.locator(".pop .mi-t").allInnerTexts();
  check("2 the beside picker names Scout's conversation Scout", (await pick.innerText()) === "Scout", await pick.innerText());
  check("2 no beside row shows the intro ask", !all.some((t) => t.includes(INTRO)), JSON.stringify(all));
  const face = await page.locator(`.pop [data-act="beside15"][data-v="${scout.chatSessionId}"] .av`).evaluate((n) => ({ brand: n.classList.contains("brand"), colour: n.style.getPropertyValue("--c").toLowerCase() }));
  check("2 and draws Scout's face, not Branch's", !face.brand && face.colour === "#b84a6b", JSON.stringify(face));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.locator("#pal-in").waitFor();
  const everything = await page.locator("#pal-list .mi-t").allInnerTexts();
  check("2 the command palette lists no conversation by the intro ask", !everything.some((t) => t.includes(INTRO)), `${everything.length} items`);
  await page.locator("#pal-in").fill("Scout");
  await page.waitForTimeout(300);
  const found = await page.locator("#pal-list .mi-t").allInnerTexts();
  check("2 the palette finds Scout's conversation as Scout", found.includes("Scout"), JSON.stringify(found));
  await page.keyboard.press("Escape");
}

/* 3, on the fresh engine: the + menu, A Trunk from a job, and Have Branch make a Trunk starting a real task. */
async function plusMenu(page) {
  await page.locator('#side [data-act="newmenu"]').click();
  const menu = page.locator(".pop");
  const order = await menu.locator(".mi-t").allInnerTexts();
  const want = ["New conversation", "New Trunk", "New room", "New automation", "A Trunk from a job…", "New group chat", "Have Branch make a Trunk"];
  check("3 the + menu has the prototype's items in its order", JSON.stringify(order.slice(0, want.length)) === JSON.stringify(want), JSON.stringify(order));
  const job = menu.getByRole("menuitem", { name: "A Trunk from a job…" }), mk = menu.getByRole("menuitem", { name: "Have Branch make a Trunk" });
  check("3 neither new item is greyed", !(await greyed(job)) && !(await greyed(mk)));
  await job.click();
  await page.locator("#main").getByRole("heading", { name: "Start from a job" }).waitFor();
  const tab = await page.locator('#main .tab[data-place="customize"][data-v="trunks"]').getAttribute("aria-selected");
  check("3 A Trunk from a job… opens Customize › Trunks at the job templates", tab === "true");
  await page.locator('#main [data-act="tmpl"][data-i="0"]').click();
  const made = await until(async () => (await api("trunks")).trunks.find((t) => t.name === "Inbox Manager"), 20000);
  check("3 a job template makes its Trunk (GET /api/trunks)", made && made.title === "Clears your inbox and drafts replies in your voice", made?.id);

  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator(".pop").getByRole("menuitem", { name: "Have Branch make a Trunk" }).click();
  const dlg = page.locator(".dlg");
  await dlg.getByRole("heading", { name: "Have Branch make a Trunk" }).waitFor();
  const before = (await api("sessions")).sessions.length;
  await dlg.getByRole("button", { name: "Propose it" }).click();
  await page.waitForTimeout(500);
  check("3 an empty box sends nothing (the placeholder is never the ask)", (await dlg.count()) === 1 && (await api("sessions")).sessions.length === before);
  const what = "watch my subscriptions and tell me before anything renews";
  await dlg.locator("#mk-what").fill(what);
  await dlg.getByRole("button", { name: "Propose it" }).click();
  const session = await until(async () => (await api("sessions")).sessions.find((s) => (s.opening ?? "").startsWith("Make me a Trunk:")), 20000);
  const said = session ? (await api(`sessions/${session.sessionId}`)).messages.find((m) => m.role === "user")?.content : "";
  check("3 Propose it starts a real task: a new conversation with the owner's words (GET /api/sessions/<id>)", said === `Make me a Trunk: ${what}`, said);
  const run = session && await until(async () => ((await api("state")).runs ?? []).find((r) => r.sessionId === session.sessionId), 10000);
  check("3 and the engine ran it (GET /api/state runs)", run && run.prompt === `Make me a Trunk: ${what}`, run?.status);
  if (session) await idle(api, session.sessionId);
}

/* 4: a room's face is a stack of two member faces, in the list and in its header. */
async function roomFaces(page, scout, plain) {
  const { room } = await api("trunks/rooms", { name: "Pair", members: [scout.id, plain.id] });
  check("4 setup: the room has both Trunks as members (GET /api/trunks rooms)", (await api("trunks")).rooms.find((r) => r.id === room.id)?.members.length === 2);
  await page.reload();
  await page.locator("#prompt").waitFor();
  const row = page.locator(`#side .row[data-id="${room.sessionId}"] .avw`);
  await row.waitFor({ timeout: 20000 });
  const stack = await row.evaluate((n) => { const s = n.querySelector(".stack"); return s ? [...s.querySelectorAll(".av")].map((a) => ({ brand: a.classList.contains("brand"), colour: a.style.getPropertyValue("--c").toLowerCase() })) : null; });
  const plainColour = await page.locator(`#side .row[data-id="${plain.chatSessionId}"] .av`).evaluate((n) => n.style.getPropertyValue("--c").toLowerCase());
  check("4 the room's row is a stack of two faces, not Branch's", stack?.length === 2 && !stack.some((f) => f.brand), JSON.stringify(stack));
  check("4 the two faces are the members' (Scout's colour, then Plain's as its own row draws it)", stack?.[0].colour === "#b84a6b" && stack?.[1].colour === plainColour, JSON.stringify(stack));
  await openRow(page, room.sessionId);
  const head = await page.locator(".head:visible .stack .av").count();
  check("4 the room's header draws the same stack", head === 2, `${head} faces`);
}

/* 6: after a reload the "New to Branch?" card never covers the message box or Send, on a wide and a phone-sized window. */
async function welcomeCard(browser) {
  for (const [width, height] of [[1280, 860], [390, 800]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const { page, errors } = await signIn(context, BASE, TOKEN, api);
    await page.evaluate(() => { localStorage.setItem("branch-setup-seen", "1"); localStorage.removeItem("branch-welcomed"); });
    await page.reload();
    await page.locator("#prompt").waitFor();
    const card = page.locator(".welcome10");
    await card.waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const c = r(".welcome10"), box = r("#composer"), send = r("#send");
      const apart = (a, b) => a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
      const hit = document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2);
      return { clear: apart(c, box) && apart(c, send), sendOnTop: !!hit?.closest("#send"), card: Math.round(c.bottom), box: Math.round(box.top) };
    });
    check(`6 at ${width}px the New to Branch? card sits clear of the message box and Send`, geo.clear, `card bottom ${geo.card}, box top ${geo.box}`);
    check(`6 at ${width}px Send is what a click there reaches`, geo.sendOnTop);
    await page.locator("#prompt").fill("line one\nline two\nline three\nline four");
    await page.waitForTimeout(300);
    const grown = await page.evaluate(() => {
      const c = document.querySelector(".welcome10").getBoundingClientRect(), box = document.querySelector("#composer").getBoundingClientRect();
      return c.bottom <= box.top;
    });
    check(`6 at ${width}px it stays clear while the message box grows`, grown);
    await page.locator('.welcome10 [data-act="welcome-x"]').click();
    check(`6 at ${width}px no page errors`, errors.length === 0, errors.join(" | "));
    await context.close();
  }
}

/* 5: the demo language taken out is not what the window serves. */
async function served() {
  const gone = [["/app/flows/setup.js", "Google Drive"], ["/app/settings/p17-permissions.js", "unknown.example"], ["/app/flows/tour.js", "55 of them"],
    ["/app/flows/tour.js", "GPT-6 Sol"], ["/app/flows/tour.js", "Five places"], ["/app/settings/pages/usage.js", 'data-act="ckpt-demo"'], ["/app/settings/pages/voice.js", "read out at 7:30"]];
  /* The window's words now live in the locale files too (t()), so the English and French files are read as well. */
  gone.push(["/locales/en.json", "55 of them"], ["/locales/en.json", "GPT-6 Sol"], ["/locales/en.json", "Five places"], ["/locales/en.json", "read out at 7:30"],
    ["/locales/en.json", "window.settings.usage.show-me"], ["/locales/en.json", "window.flows.setup.mail-cal"], ["/locales/fr.json", "55 au total"], ["/locales/fr.json", "lu à 7 h 30"]);
  for (const [path, words] of gone) {
    const text = await (await fetch(BASE + path, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    check(`5 ${path} no longer carries “${words}”`, text.length > 200 && !text.includes(words), `${text.length} bytes`);
  }
}

/* 3, on an engine whose model answers "Make me a Trunk" with the trunk.propose tool: the card, Make and No thanks. */
async function proposals(browser) {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-bugfix-9-"));
  const PROPOSE = { quill: { name: "Quill", title: "Subscriptions and renewals", description: "Watches your subscriptions and tells you before one renews.", why: "You asked for one." },
    wren: { name: "Wren", title: "Birdsong", description: "Listens.", why: "You asked." },
    moss: { name: "Moss", title: "Garden", description: "Keeps the garden notes.", why: "You asked." } };
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    /* Like a real model, it can only call a tool the request offers; without it, it would answer in words. */
    const offered = (request.tools ?? []).some((tool) => tool.name === "trunk.propose");
    if (last?.role === "user" && /^Make me a Trunk: /.test(last.content) && !offered) return { content: "I cannot propose a Trunk here.", toolCalls: [] };
    if (last?.role === "user" && /^Make me a Trunk: /.test(last.content)) {
      const which = /another/.test(last.content) ? PROPOSE.wren : /garden/.test(last.content) ? PROPOSE.moss : PROPOSE.quill;
      // The same call id every turn, as a connection that numbers calls afresh each turn (Ollama) gives.
      return { content: "", toolCalls: [{ id: "c1", name: "trunk.propose", arguments: JSON.stringify(which) }] };
    }
    if (last?.role === "tool") return { content: "Here is the Trunk I would make.", toolCalls: [] };
    return { content: "Hello.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call = client(base, server.token);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const { page, errors } = await signIn(context, base, server.token, call);
  const ask = async (words) => {
    await page.locator('#side [data-act="newmenu"]').click();
    await page.locator(".pop").getByRole("menuitem", { name: "Have Branch make a Trunk" }).click();
    await page.locator(".dlg #mk-what").fill(words);
    await page.locator(".dlg").getByRole("button", { name: "Propose it" }).click();
  };
  try {
    await ask("watch my subscriptions and tell me before anything renews");
    const card = page.locator("#conversation .card.mk10");
    await card.waitFor({ timeout: 30000 });
    const text = await card.innerText();
    check("3 Branch's trunk.propose call is drawn as the prototype's card (A new Trunk, proposed · Needs you)", text.includes("A new Trunk, proposed") && text.includes("Needs you") && text.includes("Quill") && text.includes(PROPOSE.quill.description), text.replace(/\s+/g, " "));
    check("3 the card draws only what the proposal holds (no Tools, Computer, May or Talks to rows)", !/Tools|Computer|Talks to/.test(await card.locator("dl").innerText()));
    check("3 nothing is made before the owner says so (GET /api/trunks)", !(await call("trunks")).trunks.some((t) => t.name === "Quill"));
    const make = card.getByRole("button", { name: "Make Quill" });
    check("3 Make Quill is live", !(await greyed(make)));
    await make.click();
    const quill = await until(async () => (await call("trunks")).trunks.find((t) => t.name === "Quill"), 15000);
    check("3 Make Quill made the proposed Trunk with its title and job (GET /api/trunks)", quill && quill.title === PROPOSE.quill.title && quill.description === PROPOSE.quill.description, quill?.id);
    const done = page.locator("#conversation .card").filter({ hasText: "Quill is made" });
    await done.waitFor({ timeout: 10000 });
    check("3 the card now says Quill is made · Ready", (await done.innerText()).includes("Ready"));
    await done.getByRole("button", { name: "Open Quill" }).click();
    const opened = await until(() => page.evaluate((sid) => document.querySelector(`#side .row[data-id="${sid}"]`)?.getAttribute("aria-current") === "true", quill.chatSessionId), 10000);
    check("3 Open Quill opens Quill's own conversation", opened);

    await ask("make another one");
    const second = page.locator("#conversation .card.mk10").filter({ hasText: "Wren" });
    await second.waitFor({ timeout: 30000 });
    await second.getByRole("button", { name: "No thanks" }).click();
    await second.waitFor({ state: "detached", timeout: 5000 });
    check("3 No thanks puts the card away and makes nothing (GET /api/trunks)", !(await call("trunks")).trunks.some((t) => t.name === "Wren"));

    await ask("one for my garden");
    const third = page.locator("#conversation .card.mk10").filter({ hasText: "Moss" });
    await third.waitFor({ timeout: 30000 });
    await third.getByRole("button", { name: "Change it first" }).click();
    await page.locator(".dlg").getByRole("heading", { name: "Edit Moss" }).waitFor({ timeout: 15000 });
    const moss = (await call("trunks")).trunks.find((t) => t.name === "Moss");
    check("3 Change it first makes the proposed Trunk (GET /api/trunks) and opens its editor", moss && moss.title === PROPOSE.moss.title);
    await page.locator('.dlg-h [data-act="dlg-close"]').click();
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
    const scout = (await api("trunks", { name: "Scout", title: "Watches prices", description: "" })).trunk;
    await api(`trunks/${scout.id}`, { chosenColour: "#b84a6b" });
    const plain = (await api("trunks", { name: "Plain", title: "", description: "" })).trunk;
    await replied(api, scout.chatSessionId);
    await replied(api, plain.chatSessionId);
    const hello = await api("run", { prompt: "Hello" });
    await idle(api, hello.sessionId);
    await page.reload();
    await page.locator(`#side .row[data-id="${scout.chatSessionId}"]`).waitFor({ timeout: 20000 });
    await intro(page, scout, plain);
    await titles(page, scout, hello.sessionId);
    await plusMenu(page);
    await roomFaces(page, scout, plain);
    await served();
  } catch (e) { check("script finished", false, e.stack); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  try { await welcomeCard(browser); } catch (e) { check("welcome card checks finished", false, e.stack); }
  await proposals(browser);
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
