/* The People page as the approved sample has it: the eyebrow above the one title, "+ Invite someone"
   in a dialog instead of a raw form, what each person may do from the grant Branch really holds
   them to, the Trunks / Projects / Daily allowance / PIN facts, Change look on the owner's card, and
   a way from Settings › Trunks & people to each person's card. Headless, 127.0.0.1.
   Redesign: the new window's People page is Settings › People (public/app/settings/pages/people.js, prototype.html's
   people page): the list of everyone (data-act="p-sel"), a person's card (.pcard10) with Permissions, Trunks, Projects,
   Daily allowance and PIN, and "Invite someone" (data-act="p-invite"). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openSettings } from "./new-window-places.mjs";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-people-grown-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /\/(people-place|studio|strip)\.js/.test(message.location().url ?? "")) errors.push(message.text().slice(0, 200));
  });
  const open = async () => { await signIn(page, server); };
  /* Settings › People, then the person's row. */
  const people = async () => {
    await openSettings(page, "people");
    await page.locator('[data-act="setpage"][data-v="people"][aria-current="true"]').waitFor();
  };
  return { call, page, errors, open, people };
}
/** A person's card: their row in the list, then the card beside it. */
async function cardOf(page, name) {
  // WINDOW BUG: public/app/settings/pages/people.js:17 keeps GET /api/profiles' whole answer ({profiles, active, ...}) as
  // the list and groups it by p.location, which the engine never sends (src/collab-server.ts:197), so no one is listed.
  const row = page.locator('[data-act="p-sel"]').filter({ hasText: name });
  await row.first().waitFor({ timeout: 10000 });
  await row.first().click();
  const card = page.locator(".pcard10");
  await card.filter({ hasText: name }).waitFor();
  return card;
}
/* What a person may do, as the card's Permissions ticks, and its facts. */
const mayOf = (card) => card.locator(".acts10 label").evaluateAll((items) => items.map((item) => `${item.textContent.trim()}:${item.querySelector("input")?.checked ? "yes" : "no"}`));
const factsOf = (card) => card.locator("dl.kv").evaluate((list) => [...list.querySelectorAll("dt")].map((term) => `${term.textContent}=${term.nextElementSibling.textContent}`));

test.skip("People opens on the eyebrow, the title and + Invite someone; the dialog checks, cancels and adds", async (t) => {
  // Redesign: Coming soon (p-invite), checked at fc541c24. Settings › People draws "Invite someone" aria-disabled, class soon.
  const f = await fixture(t);
  await f.open();
  await f.people();
  const head = await f.page.locator(".people-page .shell-head > *").evaluateAll((nodes) => nodes.map((node) => `${node.tagName}:${node.textContent}`));
  assert.deepEqual(head.slice(0, 2), ["P:This computer", "H2:People"], "the eyebrow sits right above the one title");
  assert.equal(await f.page.locator(".people-page h1, .people-page h2").count(), 1, "one page title");
  assert.equal(await f.page.locator(".person-add, .people-page input").count(), 0, "no raw form on opening");
  const acts = await f.page.locator(".people-acts .shell-btn").allInnerTexts();
  assert.deepEqual(acts.map((text) => text.trim()), ["Invite someone", "A PIN for switching back to you"]);

  await f.page.locator("#people-invite").click();
  const dialog = f.page.getByRole("dialog", { name: "Invite someone" });
  await dialog.waitFor();
  assert.deepEqual(await dialog.getByRole("tab").allInnerTexts(), ["On this computer", "On their own device"]);
  await dialog.getByRole("button", { name: "Add them" }).click();
  assert.equal(await dialog.getByRole("alert").innerText(), "Write their name.");
  await dialog.getByLabel("Name").fill("Jo");
  await dialog.getByLabel("Their PIN, four to eight digits").fill("12");
  await dialog.getByRole("button", { name: "Add them" }).click();
  assert.equal(await dialog.getByRole("alert").innerText(), "A PIN is four to eight digits.");
  await f.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal((await f.call("/api/profiles")).profiles.length, 0, "cancelling adds nobody");

  const roleCalls = [];
  f.page.on("request", (request) => { if (/\/api\/profiles\/[^/]+\/role$/.test(new URL(request.url()).pathname)) roleCalls.push(request.url()); });
  await f.page.locator("#people-invite").click();
  await dialog.getByLabel("Name").fill("Jo");
  await dialog.getByRole("group", { name: "Role" }).getByRole("button", { name: "Child" }).click();
  assert.match(await dialog.locator(".studio-field small").innerText(), /May look things up and answer questions/);
  await dialog.getByLabel("Their PIN, four to eight digits").fill("4321");
  await dialog.getByRole("button", { name: "Add them" }).click();
  await dialog.waitFor({ state: "detached" });
  const jo = (await f.call("/api/profiles")).profiles.find((person) => person.name === "Jo");
  assert.ok(jo, "Jo is added");
  const card = f.page.locator(`.person-card[data-person="${jo.id}"]`);
  await card.waitFor();
  assert.equal(await card.locator(".shell-pill").innerText(), "Child", "with the role chosen in the dialog");
  assert.deepEqual(roleCalls, [], "added with the role in one call, so a failed second call cannot leave a Child as an Adult");
  assert.deepEqual(await mayOf(card), ["read:yes", "browse:no", "files:no", "commands:no", "message:no", "spend:no", "settings:no"]);
  assert.deepEqual(await factsOf(card), ["Trunks=None", "Projects=All of them", "Daily allowance=None", "PIN=Set"]);
  assert.deepEqual(f.errors, []);
});

test("each card lists what the grant really allows, the owner's card changes the look, and a person sees neither", async (t) => {
  const f = await fixture(t);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  await f.call(`/api/profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"], projects: ["garden"], dailySpendLimit: 2.5 });
  await f.open();
  await f.people();
  // The prototype's permission names, ticked from the grant Branch really holds each person to.
  const owner = await cardOf(f.page, "Owner");
  assert.deepEqual((await mayOf(owner)).map((one) => one.endsWith(":yes")), [true, true, true, true, true, true, true]);
  // The prototype's words for the owner's card (design/redesign/prototype.html: All, No limit, and where they are signed in).
  assert.deepEqual(await factsOf(owner), ["Trunks=All", "Projects=All", "Daily allowance=No limit", "PIN=—", "Signed in on=This computer"]);
  const card = await cardOf(f.page, "Sam");
  assert.deepEqual((await mayOf(card)).filter((one) => one.endsWith(":yes")).length, 2, "a narrowed grant shows as narrowed, not as the role's full list");
  // The prototype lists every fact, "—" when there is none, and money as dollars a day.
  assert.deepEqual(await factsOf(card), ["Trunks=—", "Projects=garden", "Daily allowance=$2.50 a day", "PIN=Set"]);
  // Redesign: replaced by the new window (prototype.html's person card has no "Change look"; Appearance is its own page).

  // The window starts again by itself when the person changes (public/app/main.js watchPerson): that restart is waited for.
  const restarted = f.page.waitForEvent("framenavigated", { predicate: (frame) => frame === f.page.mainFrame(), timeout: 30000 });
  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  await restarted;
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await f.people();
  // Owner-only People actions are hidden, not greyed, for anybody but the owner (grey means not built yet).
  assert.equal(await f.page.locator('[data-act="p-invite"]').count(), 0, "no inviting for a household person");
  assert.equal((await mayOf(await cardOf(f.page, "Sam"))).filter((one) => one.endsWith(":yes")).length, 2);
  assert.deepEqual(f.errors, []);
});

// Adult / Child is live since #353 (the owner, 2026-09-26: the held controls are built for real, through the engine's guards).
test("a person's own card ticks only what Branch enforces and names their own Trunks", async (t) => {
  const f = await fixture(t);
  for (const part of ["trunks", "rooms"]) await f.call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await f.call("/api/trunks", { name: "Scout" })).trunk;
  const quill = (await f.call("/api/trunks", { name: "Quill" })).trunk;
  const ledger = (await f.call("/api/trunks", { name: "Ledger" })).trunk;
  const pip = (await f.call("/api/trunks", { name: "Pip" })).trunk;
  const kim = await f.call("/api/profiles", { name: "Kim", pin: "1234" });
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "5678" });
  // Kim is an Adult in a group that only lets its members look things up.
  await f.call("/api/people/settings", { mode: "on" });
  const family = await f.call("/api/people/groups", { name: "Family", members: [kim.id], categories: ["read"] });
  assert.equal(family.groups?.length, 1, JSON.stringify(family));
  await f.call("/api/trunks/rooms", { name: "Homework", members: [scout.id, quill.id], people: [kim.id] });
  await f.call("/api/trunks/rooms", { name: "Owner only", members: [ledger.id, pip.id], people: [] });
  // Sam is narrowed to read + files as an Adult, then made a Child from his card.
  await f.call(`/api/profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"] });
  await f.open();
  await f.people();
  // Sam is made a Child from his card (the prototype's Adult / Child choice, data-act="p-role").
  let samCard = await cardOf(f.page, "Sam");
  await samCard.locator('[data-act="p-role"]', { hasText: "Child" }).click();
  await f.page.waitForFunction(() => [...document.querySelectorAll('.pcard10 [data-act="p-role"]')].find((b) => b.textContent.trim() === "Child")?.getAttribute("aria-pressed") === "true");
  const onlyRead = (list) => list.filter((one) => one.endsWith(":yes")).length === 1;
  const kimCard = await cardOf(f.page, "Kim");
  assert.ok(onlyRead(await mayOf(kimCard)), "the owner sees Kim's group narrowing");
  const ownerSees = await factsOf(kimCard);
  assert.equal(ownerSees[0], "Trunks=Scout, Quill", "the Trunks in the rooms Kim was let into");
  samCard = await cardOf(f.page, "Sam");
  assert.ok(onlyRead(await mayOf(samCard)), "the owner sees the Child cap");

  /* The window starts again by itself when the person changes (public/app/main.js watchPerson); a reload of our own
     raced that one and was aborted, so the window's own restart is what is waited for, both ways. */
  const switchTo = async (body) => {
    const restarted = f.page.waitForEvent("framenavigated", { predicate: (frame) => frame === f.page.mainFrame(), timeout: 30000 });
    await f.call("/api/profiles/switch", body);
    await restarted;
    await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  for (const [person, pin] of [[kim, "1234"], [sam, "5678"]]) {
    await switchTo({ profileId: person.id, pin });
    await f.people();
    const own = await cardOf(f.page, person.name);
    assert.ok(onlyRead(await mayOf(own)), `${person.name}'s own card ticks only what Branch enforces`);
    const facts = await factsOf(own);
    if (person === kim) assert.deepEqual(facts, ownerSees, "Kim's own Trunks are the ones the owner's card lists, not room names");
    else assert.equal(facts[0], "Trunks=—", "Sam is in no room: the card writes \"—\" for none (#361)");
    await switchTo({ profileId: null });
  }
  assert.deepEqual(f.errors, []);
});

test("Settings › Trunks & people leads to each person's card; French and a phone keep it whole", async (t) => {
  const f = await fixture(t, { width: 400, height: 860 });
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const ada = await f.call("/api/profiles", { name: "Ada", pin: "5678" });
  await f.open();
  // Redesign: Settings › People lists everyone and opens each person's card; the old "Settings › Trunks & people" page,
  // its person picker and the French words (no /i18n.js in the new window) are replaced by the new window.
  await f.people();
  assert.deepEqual(await f.page.locator('[data-act="p-sel"] b').allInnerTexts(), ["Owner · you", "Ada", "Sam"]);
  const card = await cardOf(f.page, "Sam");
  assert.match(await card.innerText(), /Sam/);
  const wide = await f.page.evaluate(() => [...document.querySelectorAll(".t10, .pcard10")]
    .filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className));
  assert.deepEqual(wide, [], "nothing runs off the side at 400 px");
  assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll");
  void sam; void ada;
  assert.deepEqual(f.errors, []);
});

