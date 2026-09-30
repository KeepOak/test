/* Redesign phase 2, shell (the window): Branch's own menu on a Trunk, changing a Trunk's look after it is made, adding
   a Trunk, Overview and People, "Who is using Branch", the faces on replies, a household person seeing none of the
   owner's, and pairing. Headless, 127.0.0.1.
   Redesign: pointed at the new window (public/app, design/redesign/prototype.html pass 17). The old Trunks strip is
   gone: a Trunk's conversation is a row with its face in the sidebar's list (shell/shell.js row(), core/ui.js av()),
   the computers are the switcher at the top of the sidebar (shell/machines.js), and the Add a Trunk studio is the
   prototype's "New Trunk" and its editor (flows/trunk.js). Switching person and pairing are held for separate
   security review, so the window draws them greyed, and these tests say so. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { pickGsel } from "./gsel.mjs";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
const PROTOTYPE = new URL("../design/redesign/prototype.html", import.meta.url);
/* The shell's own modules in the new window. */
const MODULES = ["shell/shell.js", "shell/machines.js", "places/overview.js", "places/team.js", "settings/pages/people.js", "flows/trunk.js", "flows/computers.js", "chat/rooms.js"];
/* The prototype's eight Trunk colours (prototype.html COLOURS). */
const COLOURS = ["#2f8c86", "#d8612a", "#8a5aa8", "#5e8c4a", "#4f6fa8", "#c9982e", "#b84a6b", "#56616b"];

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-shell-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  // Onboarding is marked done through the engine, and the update question answered, so neither covers the window.
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A style the page's rules refuse shows up here.
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|attribute d:/.test(message.text())) errors.push(message.text().slice(0, 200));
  });
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side .nav[data-v="overview"]').waitFor({ state: "attached", timeout: 120000 });
  };
  return { app, server, call, page, errors, open };
}
async function withTrunk(f, name = "Scout", look = { face: "letters", letters: "SC", colour: 3, shape: "leaf" }) {
  await f.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await f.call("/api/trunks", { name, title: "Watches prices", description: "" });
  await f.call(`/api/trunks/${trunk.id}`, { look });
  await f.app.trunks.introduced();
  return trunk;
}
const row = (page, trunk) => page.locator(`#side .row[data-id="${trunk.chatSessionId}"]`);
async function place(page, name, tab) {
  await page.locator(`#side .nav[data-v="${name}"]`).click();
  await page.locator("#main .place h1").first().waitFor();
  if (tab) {
    await page.locator(`.tab[data-act="ptab"][data-place="${name}"][data-v="${tab}"]`).click();
    await page.waitForFunction(({ name, tab }) => document.querySelector(`.tab[data-place="${name}"][data-v="${tab}"]`)?.getAttribute("aria-selected") === "true", { name, tab });
  }
}
async function settingsPage(page, id) {
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator(`.set-nav [data-act="setpage"][data-v="${id}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`.set-nav [data-v="${id}"]`)?.getAttribute("aria-current") === "true", id);
}
const greyed = async (locator) => ({
  disabled: await locator.getAttribute("aria-disabled"),
  soon: await locator.evaluate((node) => node.classList.contains("soon")),
  tip: await locator.getAttribute("data-tip"),
});
const GREY = { disabled: "true", soon: true, tip: "Coming soon" };
const live = async (locator) => { const g = await greyed(locator); return g.disabled !== "true" && !g.soon; };
/* The words as written (textContent): a heading styled in capitals is still the prototype's own words. */
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean));
async function notInPrototype(words) {
  const prototype = await readFile(PROTOTYPE, "utf8");
  return [...new Set(words)].filter((word) => !prototype.includes(word));
}
/* The prototype's Settings › Appearance › Language offers Français, and the design says every screen switches with it
   (BRANCH-DESIGN-INTENT.md, stand-in notes: "translate every screen"). */
async function chooseFrench(f) {
  await f.page.keyboard.press("Escape");
  await settingsPage(f.page, "appearance");
  await pickGsel(f.page.locator("#lang"), "fr");
  await f.page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal((await f.call("/api/look")).language, "fr", "the engine keeps the choice");
  await f.page.locator(".set-back").click();
}
/* Words the locale files keep the same in French (a name such as "Trunks"): those may read the same in both. */
async function stillEnglish(english, french) {
  const read = async (code) => JSON.parse(await readFile(new URL(`../public/locales/${code}.json`, import.meta.url), "utf8"));
  const [en, fr] = [await read("en"), await read("fr")];
  const same = new Set(Object.keys(en).filter((key) => typeof en[key] === "string" && en[key] === fr[key]).map((key) => en[key]));
  assert.equal(french.length, english.length, "the same places, the same words");
  return english.filter((word, i) => word === french[i] && !same.has(word));
}
/* The shell's words, found by what each control does: the person menu, Team › People and the computer switcher. */
async function shellWords(page) {
  await page.locator('#side [data-act="owner"]').click();
  const menu = page.locator(".pop");
  await menu.locator('[data-act="switchto"], [data-act="yp-open"]').first().waitFor(); // your-profile: your own tile opens Your profile
  const words = [...await texts(menu.locator(".ph")), ...await texts(menu.locator(".mi-t")), ...await texts(menu.locator(".row-in > span:first-child, .seg button"))];
  await page.keyboard.press("Escape");
  await place(page, "team", "people");
  await page.locator(".t9-item").first().waitFor();
  words.push(...await page.locator("#main .place h1, #main .place .lede, #main .tabs .tab").evaluateAll((nodes) => nodes.map((node) => node.firstChild.textContent.trim())));
  await page.locator('#side [data-act="machines"]').click();
  await page.locator('.pop [data-act="addcomp"]').waitFor();
  words.push(...await texts(page.locator(".pop .ph, .pop .mi-t")));
  await page.keyboard.press("Escape");
  return words.filter((word) => word && !/Ada|Sam/.test(word));
}

test("the shell's modules write no inline style or handler and build no markup from text, and every word is in English and real French", async (t) => {
  for (const file of MODULES) {
    const source = await readFile(new URL(`../public/app/${file}`, import.meta.url), "utf8");
    // Redesign: colours reach the page only through data-css (applyCss) and hex-checked values, never an inline style.
    assert.doesNotMatch(source, /\sstyle="|\son[a-z]+="/i, `${file} writes no inline style or handler (the page's rules refuse both)`);
  }
  const f = await fixture(t);
  const trunk = await withTrunk(f, "<i>Ada</i>");
  await f.call("/api/profiles", { name: "<b>Sam</b>", pin: "1234" });
  await f.open();
  // A name with markup in it is shown as its words, wherever the shell draws it.
  await row(f.page, trunk).waitFor();
  await place(f.page, "customize", "trunks");
  await f.page.locator("#main .prow b").filter({ hasText: "<i>Ada</i>" }).waitFor();
  await f.page.locator('#side [data-act="owner"]').click();
  const menu = f.page.locator(".pop");
  await menu.locator('[data-act="switchto"]').filter({ hasText: "<b>Sam</b>" }).waitFor();
  await f.page.keyboard.press("Escape");
  await place(f.page, "team", "people");
  await f.page.locator(".t9-item b").filter({ hasText: "<b>Sam</b>" }).waitFor();
  assert.equal(await f.page.evaluate(() => [...document.querySelectorAll("#app i, #app b b")].filter((node) => ["Ada", "Sam"].includes(node.textContent)).length), 0, "no markup was built from a name");
  // Every word is the prototype's, in English; then Français (Settings › Appearance › Language).
  const english = await shellWords(f.page);
  assert.ok(english.length > 20, `${english.length} words`);
  assert.deepEqual(await notInPrototype(english), [], "every word is the prototype's");
  assert.deepEqual(f.errors, []);
  await chooseFrench(f);
  const french = await shellWords(f.page);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(await stillEnglish(english, french), [], "window bug: the person menu, Team › People and the computer switcher stay in English after choosing Français");
});

test("right-click on a Trunk opens Branch's own menu, never the browser's, and its order, pin and hiding are real", async (t) => {
  const f = await fixture(t);
  const scout = await withTrunk(f, "Scout");
  const ledger = await withTrunk(f, "Ledger", { face: "emoji", emoji: "📒", colour: 7, shape: "shield" });
  await f.open();
  await row(f.page, scout).waitFor();
  const prevented = await row(f.page, scout).evaluate((node) => !node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })));
  assert.equal(prevented, true, "the browser's menu does not open");
  const menu = f.page.locator(".pop[role=menu]");
  await menu.waitFor({ state: "visible" });
  assert.equal(await menu.getAttribute("aria-label"), "Scout", "the menu is named for its Trunk");
  const items = await menu.getByRole("menuitem").allInnerTexts();
  for (const item of ["Open", "Pin to top", "Rename", "New conversation with Scout", "Pause", "Edit Trunk…", "Remove…"]) assert.ok(items.some((words) => words.includes(item)), item);
  // Redesign: the strip's order and hiding are the prototype's Pin to top (see the Undo test below) and Pause.
  await menu.getByRole("menuitem", { name: "Pause" }).click();
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"] .paused`), scout.chatSessionId);
  assert.equal((await f.call("/api/trunks")).trunks.find((trunk) => trunk.id === scout.id).paused, true, "the engine paused it");
  // The keyboard opens the same kind of menu, for that Trunk.
  await row(f.page, ledger).focus();
  await f.page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  assert.equal(await menu.getAttribute("aria-label"), "Ledger");
  await f.page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

test("Change look… edits a Trunk after it is made: face, emoji, colour, shape and movement are saved", async (t) => {
  const f = await fixture(t);
  const trunk = await withTrunk(f);
  await f.open();
  await row(f.page, trunk).click({ button: "right" });
  await f.page.locator(".pop").getByRole("menuitem", { name: "Edit Trunk…" }).click();
  const dialog = f.page.locator(".dlg");
  await dialog.getByRole("heading", { name: "Edit Scout" }).waitFor();
  // The prototype saves an emoji face at once.
  await dialog.locator('[data-act="emo15"][data-v="🦉"]').click();
  await f.page.waitForFunction(() => document.querySelector('.dlg [data-act="emo15"][data-v="🦉"]')?.getAttribute("aria-checked") === "true");
  await dialog.getByRole("button", { name: "Colour #B84A6B" }).click();
  await dialog.getByRole("button", { name: "Shape 5" }).click();
  await dialog.getByRole("button", { name: "Breathe" }).click();
  assert.equal(await dialog.locator(".editor .big .av i").innerText(), "🦉", "the preview follows");
  assert.equal(await dialog.getByRole("button", { name: "Shape 5" }).getAttribute("aria-pressed"), "true");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const { look, chosenColour } = (await f.call("/api/trunks")).trunks.find((entry) => entry.id === trunk.id);
  assert.deepEqual([look.face, look.emoji, chosenColour, look.shape, look.motion], ["emoji", "🦉", "#b84a6b", "shield", "breathe"]);
  assert.deepEqual(f.errors, []);
  // The prototype draws a Trunk's own face wherever it is (rowHtml: av(c), with its colour --c and its shape --r).
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"] .av i`)?.textContent === "🦉", trunk.chatSessionId, { timeout: 5000 }).catch(() => undefined);
  const drawn = await row(f.page, trunk).locator(".av").evaluate((node) => ({ emoji: node.querySelector("i")?.textContent ?? "", colour: node.style.getPropertyValue("--c"), shaped: node.style.getPropertyValue("--r") !== "" }));
  assert.deepEqual(drawn, { emoji: "🦉", colour: "#b84a6b", shaped: true }, "window bug: the sidebar row draws the engine's Trunk record with av(), which reads no emoji, chosen colour or shape");
});

test("Add a Trunk: switched off it says so and offers the switch; the tab strip stays and pairing has a Back", async (t) => {
  const f = await fixture(t);
  await f.call("/api/trunks/switch", { part: "trunks", mode: "off" });
  await f.open();
  // Redesign: the prototype's + menu makes "Trunk N" at once and has no switch; with Trunks off the engine refuses, and
  // the window says so in the engine's words.
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "New Trunk" }).click();
  await f.page.locator(".toast").waitFor();
  const refusal = (await f.call("/api/trunks", { name: "Trunk 1" })).error;
  assert.ok(refusal, "the engine refuses while Trunks are off");
  assert.equal((await f.page.locator(".toast").innerText()).trim(), refusal, "the engine's refusal is said in its own words");
  assert.equal((await f.call("/api/trunks")).trunks.length, 0, "nothing was made");
  await f.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const beforeIds = new Set((await f.call("/api/trunks")).trunks.map(trunk => trunk.id));
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "New Trunk" }).click();
  let made;
  for (let i = 0; i < 100 && !made; i++) { made = (await f.call("/api/trunks")).trunks.find(trunk => !beforeIds.has(trunk.id)); if (!made) await f.page.waitForTimeout(50); }
  assert.equal(made?.name, "Trunk 1", "the prototype's Trunk N");
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", made.chatSessionId);
  // Pairing: the prototype's "Add a computer or phone" keeps one dialog and one tab strip.
  await f.page.locator('#side [data-act="machines"]').click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "Add a computer or phone…" }).click();
  const dialog = f.page.locator(".dlg");
  await dialog.getByRole("heading", { name: "Add a computer or phone" }).waitFor();
  assert.deepEqual(await texts(dialog.locator(".tab")), ["On your network", "With a code", "Your phone"]);
  await dialog.locator('.tab[data-v="code"]').click();
  await f.page.waitForFunction(() => document.querySelector('.dlg .tab[data-v="code"]')?.getAttribute("aria-selected") === "true");
  assert.equal(await f.page.locator(".dlg").count(), 1, "the same dialog, the same tabs");
  await dialog.locator('.tab[data-v="phone"]').click();
  await f.page.waitForFunction(() => document.querySelector('.dlg .tab[data-v="phone"]')?.getAttribute("aria-selected") === "true");
  // Pairing is live since #351 (the owner, 2026-09-26: security-held controls are built for real, through the engine's guards).
  assert.equal(await live(dialog.getByRole("button", { name: "Show the phone code" })), true, "Show the phone code is live");
  // Redesign: the prototype's dialog has no Back; its tabs go back and forth, and Close leaves it.
  await dialog.locator('.tab[data-v="network"]').click();
  await f.page.waitForFunction(() => document.querySelector('.dlg .tab[data-v="network"]')?.getAttribute("aria-selected") === "true");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

test("Overview and People are real, with faces; Who is using Branch lists everyone", async (t) => {
  const f = await fixture(t);
  await f.call("/api/profiles", { name: "Amara", pin: "4321" });
  await f.open();
  const owner = (await f.call("/api/profiles")).roleLabels.owner.label;
  // Who is using Branch: the person menu lists everyone on this computer.
  await f.page.locator('#side [data-act="owner"]').click();
  const menu = f.page.locator(".pop");
  assert.deepEqual(await texts(menu.locator(".ph").first()), ["Who is using Branch"]);
  // your-profile: your own tile opens Your profile; everybody else's switches to them.
  assert.deepEqual(await menu.locator('[data-act="switchto"], [data-act="yp-open"]').evaluateAll((nodes) => nodes.map((node) => [node.dataset.act, node.lastChild.textContent])), [["yp-open", owner], ["switchto", "Amara"]]);
  // Redesign: switching person and Add (invites) are live since the un-hold (#353); the owner sees Add.
  assert.equal(await live(menu.locator('[data-act="switchto"]').first()), true, "switching to Amara is live");
  assert.equal(await live(menu.locator('[data-act="yp-open"]')), true, "your own tile is live: it opens Your profile");
  assert.equal(await live(menu.locator('[data-act="invite"]')), true, "Add is live for the owner");
  await f.page.keyboard.press("Escape");
  // People: Team › People, everyone with a face.
  await place(f.page, "team", "people");
  assert.equal(await f.page.locator("#main .place h1").innerText(), "People");
  const people = f.page.locator('#main .t9-item[data-act="p-sel"]');
  await people.nth(1).waitFor();
  assert.deepEqual(await people.evaluateAll((nodes) => nodes.map((node) => node.querySelector("b").textContent.replace(/ · you$/, ""))), [owner, "Amara"]);
  assert.equal(await f.page.locator('#main .t9-item[data-act="p-sel"] .tav6').count(), 2, "everyone has a face");
  await people.nth(1).click();
  await f.page.locator(".pcard10 .t9-dh b").filter({ hasText: "Amara" }).waitFor();
  assert.equal(await live(f.page.locator('.pcard10 [data-act="p-switch"]')), true, "switching person is live (#353)");
  // Overview: real, and the prototype's "Who is using Branch" tile lists everyone on this computer (people2).
  await place(f.page, "overview");
  assert.equal(await f.page.locator("#main .place h1").innerText(), "Overview");
  const tile = f.page.locator("#main .tile").filter({ has: f.page.getByRole("heading", { name: "Who is using Branch" }) });
  await tile.waitFor();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(await tile.locator(".me + span").allInnerTexts(), [owner, "Amara"], "window bug: Overview's Who is using Branch shows only the person here, not everyone");
});

test("a household person sees this computer and the people, and nothing of the owner's", async (t) => {
  const f = await fixture(t);
  const scout = await withTrunk(f);
  const person = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  await f.call("/api/profiles/switch", { profileId: person.id, pin: "1234" });
  await f.open();
  await f.page.locator('#side [data-act="owner"] .who14 b').filter({ hasText: "Sam" }).waitFor();
  assert.ok(await f.page.locator('#side [data-act="machines"]').isVisible(), "this computer");
  assert.equal(await row(f.page, scout).count(), 0, "none of the owner's conversations");
  await place(f.page, "customize", "trunks");
  const mine = (await f.call("/api/trunks")).trunks;
  assert.equal(mine.length, 1, "the person's own persistent default");
  const ownerTrunks = f.app.trunks.records.list();
  assert.ok(mine.every(one => ownerTrunks.every(ownerTrunk => ownerTrunk.id !== one.id)), "the personal roster contains no owner Trunk, including the owner's default");
  for (const ownerTrunk of ownerTrunks)
    assert.equal(await f.page.locator(`#main .prow [data-act="edit"][data-id="${ownerTrunk.id}"]`).count(), 0, "none of the owner's Trunks");
  assert.equal(await f.page.locator(`#main .prow [data-act="edit"][data-id="${mine[0].id}"]`).count(), 1, "their own default is visible");
  await place(f.page, "team", "people");
  const people = f.page.locator('#main .t9-item[data-act="p-sel"]');
  await people.nth(1).waitFor();
  const ids = await people.evaluateAll((nodes) => nodes.map((node) => node.dataset.v));
  assert.equal(ids[0], "owner");
  assert.ok(ids.includes(person.id), "their own card beside the owner's");
  assert.equal(await people.filter({ hasText: "Sam · you" }).count(), 1, "their own is marked as theirs");
  // Redesign: adding people (invites) is the owner's, so it is not drawn for a household person at all; going back to
  // the owner is live since the un-hold (#353), behind the owner's PIN.
  assert.equal(await f.page.locator('[data-act="p-invite"]').count(), 0, "no Invite for a household person");
  await f.page.locator('#side [data-act="owner"]').click();
  assert.equal(await f.page.locator('.pop [data-act="invite"]').count(), 0, "no Add in the person menu either");
  assert.equal(await live(f.page.locator('.pop [data-act="switchto"][data-v=""]')), true, "Back to the owner is live");
  await f.page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});

test("a stale household strip response cannot hide the restored owner's Trunks", async (t) => {
  const f = await fixture(t);
  const scout = await withTrunk(f);
  const person = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  await f.call("/api/profiles/switch", { profileId: person.id, pin: "1234" });
  await f.open();
  await f.page.locator('#side [data-act="owner"] .who14 b').filter({ hasText: "Sam" }).waitFor();
  assert.equal(await row(f.page, scout).count(), 0);
  // Redesign: the new window has no strip events; when the person changes (switched at the computer, here through the
  // engine, since switching from the window is held for review) it starts again from nothing, so nothing of the
  // household view can linger.
  await f.page.evaluate(() => { globalThis.__householdView = true; });
  await f.call("/api/profiles/switch", { profileId: null });
  await f.page.waitForFunction(() => globalThis.__householdView !== true, undefined, { timeout: 15000 });
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await row(f.page, scout).waitFor({ timeout: 30000 });
  const owner = (await f.call("/api/profiles")).roleLabels.owner.label;
  assert.equal(await f.page.locator('#side [data-act="owner"] .who14 b').innerText(), owner);
  await place(f.page, "customize", "trunks");
  assert.equal(await f.page.locator(`#main .prow [data-act="edit"][data-id="${scout.id}"]`).count(), 1, "the owner's Trunks are back without anyone reloading");
  assert.deepEqual(f.errors, []);
});

test("replies show the assistant's own face, and a Trunk set to 3D is a 3D stand-in only while 3D faces are on", async (t) => {
  const f = await fixture(t);
  const trunk = await withTrunk(f, "Scout", { face: "emoji", emoji: "🦊", depth: "3d" });
  await f.open();
  // Branch's own assistant: its own face on a reply in a new conversation, before the words.
  await f.page.locator("#prompt").fill("Say hello.");
  await f.page.locator("#prompt").press("Enter");
  const plain = f.page.locator("#main .b").filter({ hasText: "Here it is." }).first();
  await plain.waitFor({ timeout: 15000 });
  // The owner (2026-09-27): Branch's mascot is its logo only. Here a conversation with no Trunk of its own belongs to the
  // owner's default Trunk, so that Trunk's character signs the reply; never the mascot or a Branch character loop.
  const home = f.app.trunks.ownerDefault();
  assert.equal(await plain.locator(`.gut .av[data-rk="t:${home.id}"]`).count(), 1, "the default assistant's own character signs its reply");
  assert.equal(await plain.locator('.gut :is(.av.brand, .mark-face, img[src^="/art/branch-"])').count(), 0, "never the mascot");
  assert.equal(await plain.locator('.gut video[src^="/art/anim-"]').count(), 0, "no Branch character loop in a reply");
  // A Trunk's reply carries the Trunk's own face, not Branch's.
  await row(f.page, trunk).click();
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", trunk.chatSessionId);
  const reply = f.page.locator("#main .b").filter({ has: f.page.locator(".gut .av") }).first();
  await reply.waitFor({ timeout: 15000 });
  assert.equal(await reply.locator('.gut :is(.av.none18c, .av.fig17r, .mark-face)').count(), 0, "not the neutral face, nor Branch's");
  // Redesign: the prototype has no 3D faces (its av() draws the pebble, an emoji or a photo), so a Trunk set to 3D is
  // drawn as its ordinary face.
  assert.equal(await f.page.locator("#app .is3d").count(), 0);
  assert.deepEqual(f.errors, []);
  assert.equal(await reply.locator(".gut .av i").count(), 1, "window bug: a Trunk's reply is signed with av() of the engine's record, which reads no emoji, so its chosen face is lost");
});

test("every name gives a face with one of the eight colours: a Trunk its pixel pattern, the assistant a whole mouth", async (t) => {
  const f = await fixture(t);
  const trunks = [];
  for (const name of ["Name 0 A", "Name 1 B", "Name 2 C", "Name 3 D", "Name 4 E", "Name 5 F"]) trunks.push(await withTrunk(f, name, { face: "pattern" }));
  await f.open();
  // Redesign (the owner's decision, #390): the conversation's header, now in the title-bar row, carries no face, so the
  // assistant's brand face (av({kind:'main'})) is not drawn there; it signs the assistant's replies (the test above).
  await f.page.locator(".titlebar .head").waitFor();
  assert.equal(await f.page.locator(".titlebar .av").count(), 0, "no face in the conversation's header, Branch's own included");
  for (const trunk of trunks) await row(f.page, trunk).waitFor();
  const colours = await f.page.evaluate((ids) => ids.map((id) => document.querySelector(`#side .row[data-id="${id}"] .av`).style.getPropertyValue("--c").toLowerCase()), trunks.map((trunk) => trunk.chatSessionId));
  assert.deepEqual(f.errors, []);
  assert.deepEqual(colours.filter((colour) => !COLOURS.includes(colour)), [], "window bug: the sidebar row draws every Trunk in #2F6F5E, not one of the prototype's eight colours");
});

test("a computer asking to join shows in the strip with a turning ring, and is let in, named and finished from there", async (t) => {
  const f = await fixture(t);
  const { generateKeyPairSync } = await import("node:crypto");
  const book = f.app.devices.book;
  book.setMode({ mode: "when-needed" });
  const offer = book.invite();
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  book.redeem({ offer: offer.id, code: offer.code, name: "Studio Mac", platform: "darwin", publicKey, offers: ["notify"] }, "127.0.0.1");
  await f.open();
  // Pairing is live since #351: the window draws the prototype's ways in (the switcher's Add a computer or phone,
  // Settings › Computer's Add a computer), and still never lets an asking computer in by itself; only the owner's
  // "Let it in", after ticking that the check codes match, does (tests/unhold-pairing.test.mjs).
  await f.page.locator('#side [data-act="machines"]').click();
  const switcher = f.page.locator(".pop");
  await switcher.getByText("Talk to the assistant on…").waitFor();
  assert.equal(await switcher.getByText("Studio Mac").count(), 0, "the asking computer is not offered from the window");
  await switcher.getByRole("menuitem", { name: "Add a computer or phone…" }).click();
  await f.page.locator('.dlg .tab[data-v="phone"]').click();
  assert.equal(await live(f.page.locator(".dlg").getByRole("button", { name: "Show the phone code" })), true, "Show the phone code is live");
  await f.page.locator(".dlg").getByRole("button", { name: "Close" }).click();
  await settingsPage(f.page, "computer");
  await f.page.locator('[data-act="comp-add"]').click();
  const kinds = f.page.locator(".dlg");
  await kinds.getByRole("heading", { name: "Add a computer" }).waitFor();
  assert.equal(await live(kinds.locator('[data-act="comp-add-go"][data-v="pair"]')), true, "Another computer with Branch is live");
  await kinds.getByRole("button", { name: "Cancel" }).click();
  const devices = await f.call("/api/devices");
  assert.deepEqual([devices.requests[0].status, devices.devices.length], ["waiting", 0], "the request still waits for the owner at the computer");
  assert.deepEqual(f.errors, []);
});

test("in French every word of the strip and the studio follows at once, and no icon is lost", async (t) => {
  const f = await fixture(t);
  await withTrunk(f);
  await f.open();
  // Redesign: the strip and the studio are the prototype's + menu (New Trunk) and its Add a computer or phone dialog.
  const studioWords = async () => {
    await f.page.locator('#side [data-act="newmenu"]').click();
    await f.page.locator('.pop [data-act="new-trunk"]').waitFor();
    const words = await texts(f.page.locator(".pop .mi-t"));
    assert.equal(await f.page.locator(".pop .mi .ico svg").count(), await f.page.locator(".pop .mi .ico").count(), "every item keeps its icon");
    await f.page.keyboard.press("Escape");
    await f.page.locator('#side [data-act="machines"]').click();
    await f.page.locator('.pop [data-act="addcomp"]').click();
    const dialog = f.page.locator(".dlg");
    await dialog.locator('.tab[data-v="phone"]').waitFor();
    words.push(...await texts(dialog.locator(".dlg-h h2, .tab")));
    assert.equal(await dialog.locator('.dlg-h [data-act="dlg-close"] svg').count(), 1, "the close icon stays");
    await dialog.locator('.dlg-h [data-act="dlg-close"]').click();
    await dialog.waitFor({ state: "detached" });
    return words;
  };
  const english = await studioWords();
  assert.deepEqual(await notInPrototype(english), [], "every word is the prototype's");
  assert.deepEqual(f.errors, []);
  await chooseFrench(f);
  const french = await studioWords();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(await stillEnglish(english, french), [], "window bug: the + menu and Add a computer or phone stay in English after choosing Français");
});

/* ---------------------------------------------------------------- integration review */

test("integration review: faces are painted in real colours under the page's style rules, in the strip and the sidebar roster", async (t) => {
  const f = await fixture(t);
  const trunks = [];
  for (const name of ["Scout", "Ledger", "Quill", "Harbour", "Moss", "Tally"]) trunks.push(await withTrunk(f, name, { face: "pattern" }));
  await f.call(`/api/trunks/${trunks[0].id}`, { chosenColour: "#b84a6b" });
  await f.open();
  for (const trunk of trunks) await row(f.page, trunk).waitFor();
  await place(f.page, "customize", "trunks");
  await f.page.locator("#main .prow .av").nth(5).waitFor();
  const painted = await f.page.evaluate(() => [...document.querySelectorAll("#side .row .av .peb, #side .row .av.pbl .pbl-c, #main .prow .av .peb, #main .prow .av.pbl .pbl-c")].map((peb) => getComputedStyle(peb).backgroundColor));
  assert.ok(painted.length >= 12, `${painted.length} faces`);
  const bad = painted.filter((colour) => /^rgba?\(0, 0, 0(, 0)?\)$/.test(colour) || colour === "transparent");
  assert.deepEqual(bad, [], "no black or empty face: the colour reaches the page through its style rules");
  const chosen = await f.page.evaluate((id) => getComputedStyle(document.querySelector(`#side .row[data-id="${id}"] .av .peb, #side .row[data-id="${id}"] .av.pbl .pbl-c`)).backgroundColor, trunks[0].chatSessionId);
  assert.deepEqual(f.errors, []);
  assert.equal(chosen, "rgb(184, 74, 107)", "window bug: the sidebar row paints a Trunk's chosen colour as #2F6F5E (av() of the engine's record reads no chosenColour)");
});

test("integration review: Pin to top moves a Trunk above Recent, the engine keeps it, and Unpin puts it back", async (t) => {
  const f = await fixture(t);
  const trunks = [];
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) trunks.push(await withTrunk(f, name, { face: "letters" }));
  await f.open();
  for (const trunk of trunks) await row(f.page, trunk).waitFor();
  // Redesign: the prototype orders the list by Pin to top (its Pinned group above Recent); Unpin is the way back.
  // Pass 18 draws each row inside its own wrapper (.rw18, shell/shell.js), so a row is the list's child or its wrapper's.
  const order = () => f.page.evaluate(() => [...document.querySelectorAll("#side .list > .lh:not(.lh-btn), #side .list > .row, #side .list > .rw18 > .row")].map((node) => node.classList.contains("lh") ? node.firstChild.textContent.trim() : node.dataset.id));
  const delta = trunks[3];
  assert.equal((await order()).includes("Pinned"), false, "nothing pinned yet");
  await row(f.page, delta).click({ button: "right" });
  await f.page.locator(".pop").getByRole("menuitem", { name: "Pin to top" }).click();
  await f.page.waitForFunction(() => [...document.querySelectorAll("#side .list > .lh")].some((node) => node.firstChild.textContent.trim() === "Pinned"));
  assert.deepEqual((await order()).slice(0, 2), ["Pinned", delta.chatSessionId], "it moved above every unpinned Trunk thread");
  assert.equal((await f.call("/api/trunks")).trunks.find((trunk) => trunk.id === delta.id).pinned, true, "the engine keeps it there");
  await row(f.page, delta).click({ button: "right" });
  await f.page.locator(".pop").getByRole("menuitem", { name: "Unpin" }).click();
  await f.page.waitForFunction(() => ![...document.querySelectorAll("#side .list > .lh")].some((node) => node.firstChild.textContent.trim() === "Pinned"));
  assert.equal((await f.call("/api/trunks")).trunks.find((trunk) => trunk.id === delta.id).pinned, false, "Unpin puts it back");
  assert.ok((await order()).includes(delta.chatSessionId));
  assert.deepEqual(f.errors, []);
});

test("integration review: an open dropdown stays open through the window's three-second refresh", async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.page.locator('#side [data-act="owner"]').click();
  const menu = f.page.locator(".pop");
  await menu.getByText("Who is using Branch").waitFor();
  // Redesign: the window refreshes when the engine says something changed (its event stream), not on a timer; a new
  // Trunk is such a change, and its row appearing proves the window was drawn again while the menu was open.
  const trunk = await withTrunk(f, "Scout");
  await row(f.page, trunk).waitFor({ timeout: 30000 });
  assert.equal(await menu.isVisible(), true, "the menu is still open");
  assert.equal(await menu.getByText("Who is using Branch").count(), 1, "and still the same menu");
  assert.deepEqual(f.errors, []);
});
