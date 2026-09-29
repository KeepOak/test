/* a2a-rooms: an agent elsewhere in a room, against a running engine seeded by seed-a2a-rooms.mjs (two Trunks and an
   agent connected by its A2A card, which has really taken one turn):
     PORT=<port> TOKEN=<hex> ROOM=<room id> SID=<room conversation> AGENT=<agent id> node design/redesign/tools/verify-a2a-rooms.cjs
   SHOTS=<folder> saves the room at desktop width and 390 wide, light and dark.
   Checks, each against the engine's own GET routes:
   - the agent's message in the prototype's dashed bubble: its initials, its card's name and the engine's badge
     ("A2A · <where it runs>"), its words as plain text; the online dot only as the engine says;
   - the owner speaking to it from the room's box: this engine refuses the agent's address (it is on this computer),
     and the room shows the engine's own words, "<agent> didn't answer: …";
   - the room's member picker (New › New room): the agent's chip, "name · where it runs"; picking it seats it
     (POST /api/trunks/rooms {agents}), which GET /api/trunks/rooms/<id> confirms. */
const { chromium } = require(process.env.PLAYWRIGHT || require("node:path").join(__dirname, "../../../node_modules/playwright"));
const { waitInPage } = require("./wait-in-page.cjs");
const { join } = require("node:path");

const { PORT = "3763", TOKEN, ROOM, SID, AGENT, SHOTS } = process.env;
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
  const bubble = thread.locator(".msg10.ext10");
  await bubble.first().waitFor({ timeout: 20000 });

  const view = await api(`trunks/rooms/${ROOM}`);
  const agent = view.outside.find((a) => a.id === AGENT);
  const said = view.events.find((e) => e.kind === "member" && e.memberId === AGENT);
  check("the engine: the agent sits in the room with its card's name and badge", agent && agent.name && /^A2A · /.test(agent.badge), JSON.stringify(agent));
  check("the engine: the agent's turn is recorded as its message", !!said, said?.text);
  const one = bubble.filter({ hasText: said.text });
  check("the dashed bubble with the agent's words", (await one.count()) === 1 && (await one.locator("p").innerText()) === said.text);
  check("its name and the engine's badge", (await one.locator("b").innerText()).startsWith(agent.name) && (await one.locator(".tag6").innerText()).toUpperCase() === agent.badge.toUpperCase(), await one.locator(".tag6").innerText());
  const initials = agent.name.split(" ").map((w) => w[0]).join("").slice(0, 2);
  check("its initials avatar", (await one.locator(".tav6").innerText()).trim() === initials);
  check("the online dot only as the engine says", (await one.locator(".st-online").count()) === (agent.online ? 1 : 0), `online ${agent.online}`);
  const border = await one.locator(":scope > div").evaluate((el) => getComputedStyle(el).borderStyle);
  check("the bubble is dashed", border === "dashed", border);

  // Speaking to it from the room: this engine refuses an address on this computer, and says so in the room.
  const before = view.events.length;
  await page.locator("#prompt").fill(`@${view.outside[0].handle} one more look please`);
  await page.locator("#send").click();
  await waitInPage(page, async ({ room, token, n }) => {
    const got = await (await fetch(`/api/trunks/rooms/${room}`, { headers: { authorization: `Bearer ${token}` } })).json();
    return got.events.length > n + 1 && !got.speaking;
  }, { room: ROOM, token: TOKEN, n: before }, { timeout: 30000, polling: 500 });
  const after = await api(`trunks/rooms/${ROOM}`);
  const refused = after.events.at(-1);
  check("the engine: the turn refused in its own words", refused.kind === "failed" && refused.text.startsWith(`${agent.name} didn't answer: `), refused.text);
  await thread.locator(".pass10").filter({ hasText: refused.text }).waitFor({ timeout: 10000 });
  check("the window: the refusal drawn in the room", (await thread.locator(".pass10").filter({ hasText: refused.text }).count()) === 1);

  if (SHOTS) {
    for (const [w, h, tag] of [[1280, 860, "desktop"], [390, 844, "390"]]) for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, scheme);
      await one.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(SHOTS, `a2a-room-${tag}-${scheme}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  }

  // The member picker: New › New room, the agent's chip, and the room it makes.
  const remote = (await api("agents/remote")).agents.find((a) => a.id === AGENT);
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('[data-act="grp-new"]').first().click();
  const chip = page.locator(`[data-act="grp-agent"][data-v="${AGENT}"]`);
  await chip.waitFor({ timeout: 10000 });
  const label = await chip.innerText();
  check("the agent's chip: name · where it runs", label === `${remote.name} · ${remote.badge.split(" · ")[1]}`, label);
  const trunks = (await api("trunks")).trunks.slice(0, 2);
  for (const tr of trunks) await page.locator(`[data-act="grp-pick"][data-v="${tr.id}"]`).click();
  await page.locator("#grp-name").fill("Agent picked");
  await page.locator(`[data-act="grp-agent"][data-v="${AGENT}"]`).click();
  check("picking it marks it", (await page.locator(`[data-act="grp-agent"][data-v="${AGENT}"]`).getAttribute("aria-pressed")) === "true");
  await page.locator('[data-act="grp-make"]').click();
  await page.waitForTimeout(1500);
  const made = (await api("trunks")).rooms.find((r) => r.name === "Agent picked");
  const seated = made ? await api(`trunks/rooms/${made.id}`) : null;
  check("the engine: the new room seats the agent", !!seated && seated.agents.includes(AGENT) && seated.outside.some((a) => a.id === AGENT), JSON.stringify(seated?.agents));

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
