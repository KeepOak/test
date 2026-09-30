/* DG-105: the studio's colours are the approved sample's (design/Branch-Grown-Up.html `swatches()`, drawn as `.swc`):
   its twenty fixed colours in its order, 30px circles 8px apart, then the rainbow "any colour" circle over the system's
   colour picker. A chosen colour is kept as #rrggbb and comes back chosen after a reload; a face drawn in it keeps its
   letters and features readable (4.5:1) in a light and a dark theme; the server refuses anything that is not a colour;
   and "Follow my theme" switched off again gives back the colour it had. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openChat } from "./open-chat.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Redesign: in the new window a Trunk's studio is "Edit Trunk…" (flows/trunk.js), opened from its conversation row's
   menu; "New Trunk" makes "Trunk N" at once, with no studio (flows/trunk.js newTrunk). Its colours are prototype.html's eight swatches (COLOURS), each named by
   its colour; there is no "any colour" picker, no Letters face and no "Follow my theme" in the design. */
const PROTOTYPE = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"];

async function signedIn(t, provider = undefined) {
  const root = await mkdtemp(join(tmpdir(), "branch-studio-colours-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(new URL(path, server.url), {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await call("POST", "/api/onboarding", { done: true });
  /* Trunks ship off; the studio shows its colours once they are on, as the Trunks switch in Settings does it. */
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* After a reload the tab still holds the key, so the window opens without asking for it again. */
  const connect = async () => {
    // The window fetches its locale before drawing (#345), so the key field appears a beat after goto: wait for it, or
    // for the window itself when the tab already holds the key, before looking.
    await Promise.race([page.getByLabel("Session token", { exact: true }).waitFor({ timeout: 60000 }),
      page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 })]).catch(() => {});
    if (await page.getByLabel("Session token", { exact: true }).isVisible()) {
      await page.getByLabel("Session token", { exact: true }).fill(server.token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
    }
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  await page.goto(server.url);
  await connect();
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors, call, connect };
}
/** "Edit Trunk…" from the Trunk's own conversation row, the way a person opens it. */
async function openEditor(page, trunk) {
  const row = page.locator(`#side .row[data-id="${trunk.chatSessionId}"]`);
  await row.waitFor();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Trunk…" }).click();
  await page.getByRole("dialog", { name: `Edit ${trunk.name}` }).waitFor();
}
const pressedColours = (page) => page.locator('.dlg [data-act="st-colour"][aria-pressed="true"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v));

test("DG-105 the studio offers the prototype's colours in its order, each named by its colour", async (t) => {
  const { page, errors, call } = await signedIn(t);
  const made = (await (await call("POST", "/api/trunks", { name: "Gardener" })).json()).trunk;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openEditor(page, made);
  assert.deepEqual(await page.locator('.dlg [data-act="st-colour"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)), PROTOTYPE);
  for (const colour of PROTOTYPE) assert.equal(await page.getByRole("button", { name: `Colour ${colour}`, exact: true }).count(), 1, `${colour} is named by its colour`);
  assert.equal(await page.locator(".dlg .swatch").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)")), true, "each is drawn in its colour");
  assert.deepEqual(errors, []);
});

test("DG-105 a chosen colour is kept as #rrggbb and comes back chosen after a reload", async (t) => {
  const { page, errors, call, connect } = await signedIn(t);
  /* New Trunk, the way a person makes one: the + menu's New Trunk names it and opens its conversation. */
  await page.getByRole("button", { name: "New conversation, Trunk, room or automation" }).click();
  await page.getByRole("menuitem", { name: "New Trunk" }).click();
  let made;
  for (let i = 0; i < 50 && !made; i++) { made = (await (await call("GET", "/api/trunks")).json()).trunks[0]; if (!made) await page.waitForTimeout(100); }
  assert.ok(made, "New Trunk made one");
  await openEditor(page, made);
  await page.getByRole("button", { name: "Colour #D8612A", exact: true }).click();
  assert.deepEqual(await pressedColours(page), ["#D8612A"]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  const [kept] = (await (await call("GET", "/api/trunks")).json()).trunks;
  /* Kept beside the look, whose own colour stays empty so a build from before this can still read it. */
  assert.deepEqual([kept.chosenColour, kept.look.colour], ["#d8612a", null]);
  await page.reload();
  await connect();
  await openEditor(page, made);
  assert.deepEqual(await pressedColours(page), ["#D8612A"]);
  assert.deepEqual(errors, []);
});

const openEdit = (page, id) => page.evaluate(async (one) => (await import("/studio.js")).openEdit(one), id).then(() => page.locator("#studio-follow").waitFor());

/** The colour row as drawn: each swatch's colour and whether it is pressed, the circles' size and spacing, and the custom one. */
const swatches = (page) => page.evaluate(() => {
  const row = document.querySelector("#studio .studio-swatches");
  const fixed = [...row.querySelectorAll("button.studio-swatch")];
  const custom = row.querySelector(".studio-swatch-custom"), box = fixed[0].getBoundingClientRect(), style = getComputedStyle(fixed[0]);
  return {
    colours: fixed.map((one) => one.dataset.colour), pressed: fixed.filter((one) => one.getAttribute("aria-pressed") === "true").map((one) => one.dataset.colour),
    drawn: fixed.every((one) => getComputedStyle(one).backgroundColor !== "rgba(0, 0, 0, 0)"),
    size: `${box.width}×${box.height}`, round: style.borderRadius, gap: getComputedStyle(row).columnGap,
    custom: custom ? { last: row.lastElementChild === custom, picker: custom.querySelector("input[type=color]")?.getAttribute("aria-label"),
      plus: custom.querySelector("span")?.textContent, size: `${custom.getBoundingClientRect().width}×${custom.getBoundingClientRect().height}`,
      rainbow: getComputedStyle(custom).backgroundImage.startsWith("conic-gradient") } : null,
    follow: document.getElementById("studio-follow").checked,
  };
});
const trunks = async (call) => (await (await call("GET", "/api/trunks")).json()).trunks;

test("DG-105 the server keeps only a real colour, and never inside the look", async (t) => {
  const { call } = await signedIn(t);
  const made = await (await call("POST", "/api/trunks", { name: "Scout", title: "", description: "" })).json();
  for (const colour of ["#12345g", "red", "#1234", "var(--x)"]) {
    const answer = await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: colour });
    assert.equal(answer.status, 400, `${colour} is refused`);
  }
  assert.equal((await call("POST", `/api/trunks/${made.trunk.id}`, { look: { colour: "#a7c080" } })).status, 400, "the look keeps tokens only");
  const kept = await (await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: "#A7C080" })).json();
  assert.equal(kept.trunk.chosenColour, "#a7c080");
  const cleared = await (await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: null, look: { colour: "theme" } })).json();
  assert.deepEqual([cleared.trunk.chosenColour, cleared.trunk.look.colour], [null, "theme"]);
});


test("TRUNK-033 a Trunk keeps its own voice in the editor, even one this computer does not have, and Default clears it", async (t) => {
  const { page, errors, call } = await signedIn(t);
  const made = (await (await call("POST", "/api/trunks", { name: "Reader" })).json()).trunk;
  assert.equal((await call("POST", `/api/trunks/${made.id}`, { voice: "Voice Kept Elsewhere" })).status, 200);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openEditor(page, made);
  const picker = page.locator("#st-voice");
  await picker.waitFor();
  assert.match(await picker.innerText(), /Voice Kept Elsewhere/, "a saved voice is shown even when it is not on this computer");
  await picker.click();
  await page.locator('.gsel-pop [data-act="gsel-pick"]', { hasText: "Default" }).click(); // whatever role the list's items carry
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached" });
  const [kept] = (await (await call("GET", "/api/trunks")).json()).trunks;
  assert.equal(kept.voice, "", "Default follows the owner's own voice setting");
  assert.deepEqual(errors, []);
});

/* TRUNK-033: a reply the window reads aloud after a send is read in the voice of the Trunk that wrote it. The window reads
   a send's answer in adopt() (chat/chat.js), which goes through readReplies so the author's voice is used. The speech
   route is stood in, so no voice service is reached.
   Mutation: in adopt() read with readNewReply(before, C.messages) (no voice) and the reply is spoken with "": red. */
test("TRUNK-033 a reply to a send is read aloud in its Trunk's own voice", async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "Read by the Trunk.", toolCalls: [] }; } };
  const { page, errors, call } = await signedIn(t, provider);
  const made = (await (await call("POST", "/api/trunks", { name: "Reader" })).json()).trunk;
  assert.equal((await call("POST", `/api/trunks/${made.id}`, { voice: "Voice Kept Elsewhere" })).status, 200);
  assert.equal((await call("POST", "/api/voice/settings", { autoReadAloud: true, readAloudWhen: "always" })).status, 200);
  const voices = [];
  await page.route("**/api/voice/speak", (r) => { voices.push(JSON.parse(r.request().postData() ?? "{}").voice); r.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0]) }); });
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openChat(page, made.chatSessionId);
  await page.locator("#prompt").fill("Read me the answer");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation", { hasText: "Read by the Trunk." }).waitFor({ timeout: 30000 });
  for (let tries = 0; tries < 100 && !voices.length; tries++) await page.waitForTimeout(100);
  assert.deepEqual(voices, ["Voice Kept Elsewhere"], "read in the Trunk's own voice");
  assert.deepEqual(errors, []);
});
