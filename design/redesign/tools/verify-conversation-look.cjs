/* conversation look: a room drawn as the prototype's group conversation, against a running engine seeded by
   seed-conversation-look.mjs (three Trunks and one household person in one room):
     PORT=<port> TOKEN=<hex> ROOM=<room id> SID=<room conversation> PERSON=<profile id> PIN=<pin> node design/redesign/tools/verify-conversation-look.cjs
   SHOTS=<folder> saves the room at desktop width and 390 wide, light and dark.
   Checks, each against the engine's own GET /api/trunks/rooms/<id>:
   - a stamp; your own message as yours; the person's message with their face, name and the online dot while they are here;
   - the Trunks' later rounds folded into "… talked it through · N messages" with the @names marked;
   - the pass as "… had nothing to add.", where it happened;
   - the Trunk that asked for you (@you) with the needs-you dot, while the room needs you;
   - the person typing (POST /api/trunks/rooms/<id>/typing as that person) shown to the owner, and gone when it ends;
   - the owner typing in the box reported to the engine, where the person sees it and the owner does not. */
const { chromium } = require("playwright");
const { join } = require("node:path");

const { PORT = "3760", TOKEN, ROOM, SID, PERSON, PIN, SHOTS } = process.env;
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
const asPerson = async (step) => {
  await api("profiles/switch", { profileId: PERSON, pin: PIN });
  try { return await step(); } finally { await api("profiles/switch", { profileId: null }); }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  await page.goto(`${base}/#open=${SID}`);
  const thread = page.locator("#conversation");
  await thread.locator(".a2a10").waitFor({ timeout: 20000 });

  const view = await api(`trunks/rooms/${ROOM}`);
  const kinds = view.events.map((e) => e.kind);
  check("the engine's room has a person's message, a pass, and later rounds", view.events.some((e) => e.personName) && kinds.includes("pass") && view.events.some((e) => e.round >= 1), kinds.join(","));
  check("a stamp is drawn", (await thread.locator(".stamp").count()) >= 1, await thread.locator(".stamp").first().innerText());
  const own = view.events.find((e) => e.kind === "user" && !e.personId);
  check("your own message is drawn as yours", (await thread.locator(".u").filter({ hasText: own.text }).count()) === 1);
  const said = view.events.find((e) => e.kind === "user" && e.personId);
  const person = thread.locator(".msg10").filter({ hasText: said.text });
  check("the person's message: their face, name and words", (await person.count()) === 1 && (await person.locator(".tav6").count()) === 1 && (await person.locator("b").innerText()) === said.personName);
  const later = view.events.filter((e) => e.kind === "member" && e.round >= 1 && !/@you\b/.test(e.text));
  const summary = await thread.locator(".a2a10 summary").innerText();
  check("Trunks talking it through: one card with the engine's count", /talked it through · \d+ messages/.test(summary) && (await thread.locator(".a2a10 .a2a-l").count()) === later.length + 1, summary);
  check("@names marked in the card", (await thread.locator(".a2a10 .mention").count()) >= 1);
  const pass = view.events.find((e) => e.kind === "pass");
  const passer = view.roster.find((m) => m.id === pass.memberId);
  check("the pass drawn as nothing to add", (await thread.locator(".pass10").innerText()).includes(`${passer.name} had nothing to add.`));
  check("the Trunk that asked for you carries the needs-you dot", view.needsYou && (await thread.locator(".b .nd18").count()) === 1);

  // The person types: the owner sees it (the engine says so first), then it ends by itself.
  /* Switching to the person and back makes the window start again (main.js watchPerson), so the room is opened again. */
  const openRoom = async () => {
    await page.waitForTimeout(1200);
    await page.locator("#prompt").waitFor({ timeout: 30000 });
    if (!(await thread.locator(".a2a10").count())) await page.goto(`${base}/#open=${SID}`);
    await thread.locator(".a2a10").waitFor({ timeout: 20000 });
  };
  const typing = async () => { await asPerson(() => api(`trunks/rooms/${ROOM}/typing`, {})); await openRoom(); };
  await typing();
  const seen = await api(`trunks/rooms/${ROOM}`);
  check("the engine: the owner sees the person typing", seen.typing.some((p) => p.id === PERSON));
  await thread.locator(".typing10").waitFor({ timeout: 8000 });
  check("the window: \"… is typing\" with their face", /is typing/.test(await thread.locator(".typing10").innerText()) && (await thread.locator(".typing10 .tav6").count()) === 1);
  check("the person is here: their online dot", (await person.locator(".st-online").count()) === 1);

  if (SHOTS) {
    for (const [w, h, tag] of [[1280, 860, "desktop"], [390, 844, "390"]]) for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await typing();
      await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, scheme); // the window's own light/dark
      await thread.locator(".typing10").waitFor({ timeout: 8000 });
      await page.evaluate(() => { const s = document.getElementById("scroll"); if (s) s.scrollTop = s.scrollHeight; });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS, `room-${tag}-${scheme}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  }
  await page.waitForFunction(() => !document.querySelector("#conversation .typing10"), null, { timeout: 15000 });
  check("typing ends by itself", (await api(`trunks/rooms/${ROOM}`)).typing.length === 0);

  // The owner types in the box: the engine records it, the person sees it, the owner never sees themselves.
  await page.locator("#prompt").pressSequentially("ok", { delay: 50 });
  await page.waitForTimeout(800);
  check("the owner's own view never shows the owner typing", (await api(`trunks/rooms/${ROOM}`)).typing.length === 0);
  const theirs = await asPerson(() => api(`trunks/rooms/${ROOM}`));
  check("the person sees the owner typing", theirs.typing.some((p) => p.id === "owner"));
  await openRoom();

  // Out of the room, the box speaks for the room no more: typing in a Trunk's own chat never reaches the room.
  await page.waitForTimeout(7000); // the owner's typing above ends by itself
  const ledger = (await api("trunks")).trunks.find((tr) => tr.chatSessionId && tr.name === view.roster[0].name);
  await page.goto(`${base}/#open=${ledger.chatSessionId}`);
  await page.waitForFunction((sid) => document.querySelector(`#side [data-act="chat"][data-id="${sid}"][aria-current="true"]`), ledger.chatSessionId, { timeout: 15000 });
  await page.locator("#prompt").pressSequentially("private", { delay: 50 });
  await page.waitForTimeout(800);
  const elsewhere = await asPerson(() => api(`trunks/rooms/${ROOM}`));
  check("typing in another conversation never shows in the room", elsewhere.typing.length === 0, JSON.stringify(elsewhere.typing));
  await page.locator("#prompt").waitFor({ timeout: 30000 });

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
