/* Redesign phase 2 "everywhere" (#44, #53): the window at phone and tablet widths, after the sample's
   frames. The phone app shows this same window, so this is its layout too. Headless only, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";

/** A model that writes a file when asked for a note: a question under "ask before changes". */
const asking = {
  name: "scripted",
  async complete(request) {
    const last = request.messages[request.messages.length - 1];
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    if (asked.includes("note")) return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Hello.", toolCalls: [] };
  },
};

const box = (page, selector) => page.locator(selector).first().boundingBox();
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the prototype has no places bar and no Trunks strip; up to 760 px its side list slides over the conversation
   ("Show conversations", data-act="side"), and from 761 px it is a column. Its approval card (#live-ask) answers with the
   action's own verb, "Always allow" (greyed out until a standing yes can be kept for one Trunk) and "Don’t allow". */
/** The same model for the new window: its yes carries the task that asked on (Q050), and the engine makes the approved
    call itself (QA R1), so the model only reports it. */
const carryingOn = {
  name: "scripted",
  async complete(request) {
    const last = request.messages.at(-1);
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    if (last.role === "user" && request.messages.some((m) => m.role === "user" && String(m.content).includes("note")))
      return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Hello.", toolCalls: [] };
  },
};
async function signedIn(t, { width = 390, height = 844, beforeOpen, provider = carryingOn } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-layout-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  // The first-run card (#323) opens under automation on purpose; these tests are about the phone layout.
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  // Reduced motion: the side list's .22 s slide-out would otherwise race what the tests read.
  page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900, serviceWorkers: "block", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await beforeOpen?.(page);
  await page.goto(server.url, { timeout: 120000 });
  const signIn = async () => {
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "attached", timeout: 120000 });
    await page.locator("#prompt").waitFor({ state: "visible", timeout: 120000 });
  };
  return { app, page, errors, signIn, workspace, server };
}
/** The side list is on the screen (not slid away to the left). */
const sideShown = (page) => page.evaluate(() => { const r = document.getElementById("side").getBoundingClientRect(); return r.right > 0 && r.width > 0; });
/** A question in this conversation, its card drawn with its answers. */
async function ask(page) {
  await page.locator("#prompt").fill("write a note for me");
  await page.locator("#send").click();
  const card = page.locator("#live-ask");
  await card.locator(".acts .btn.pri").waitFor({ state: "visible", timeout: 30000 });
  return card;
}

/* Redesign: the new window has one stylesheet (public/app.css) in place of the shared shell's; a phone still connects
   without it, and Connect still owns its own hit target. */
test("a phone can connect when the shared shell stylesheet does not load", async (t) => {
  const f = await signedIn(t, { width: 400, height: 900, beforeOpen: (page) => page.route("**/app.css", (route) => route.abort()) });
  const connect = f.page.getByRole("button", { name: "Connect", exact: true });
  await f.page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  assert.equal(await connect.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === button || button.contains(hit);
  }), true, "Connect owns its hit target");
  await connect.click();
  await f.page.locator("#app #side").waitFor({ state: "attached", timeout: 30000 });
  assert.deepEqual(f.errors, []);
});

/* Redesign: the places bar is replaced by the prototype's side list, which slides over the conversation on a phone. */
test("each place in the bar opens where the side list opens it, and says which one is showing", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  assert.equal(await sideShown(f.page), false, "on a phone the side list waits off to the side");
  for (const place of ["inbox", "library", "customize"]) {
    if (!(await sideShown(f.page))) await f.page.locator('[data-act="side"]').first().click();
    await f.page.waitForFunction(() => document.getElementById("side").getBoundingClientRect().left >= 0);
    await f.page.locator(`#side [data-act="view"][data-v="${place}"]`).click();
    await f.page.locator(`#main [data-act="ptab"][data-place="${place}"]`).first().waitFor({ state: "visible" });
    assert.equal(await f.page.locator(`#side [data-act="view"][data-v="${place}"]`).getAttribute("aria-current"), "true", `${place} says it is showing`);
    assert.equal(await f.page.locator('#side [data-act="view"][aria-current="true"]').count(), 1, "one place is showing");
    assert.equal(await noSideways(f.page), true);
  }
  assert.deepEqual(f.errors, []);
});

test("a question on a phone scrolls into view above the message box, and is answered with a thumb", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  const card = await ask(f.page);
  await f.page.waitForFunction(() => {
    const answers = document.querySelector("#live-ask .acts")?.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const head = document.querySelector(".titlebar")?.getBoundingClientRect();
    return answers && dock && head && answers.bottom <= dock.top + 1 && answers.top >= head.bottom - 1;
  }, null, { timeout: 30000 });
  for (const button of await card.locator(".acts button").all()) {
    const where = await button.boundingBox();
    assert.ok(where.x >= 0 && where.x + where.width <= 390, `${await button.innerText()} is on the screen`);
  }
  assert.equal(existsSync(join(f.workspace, "note.txt")), false, "nothing is written before the answer");
  await card.locator(".acts .btn.pri").tap();
  await f.page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  assert.equal(await readFile(join(f.workspace, "note.txt"), "utf8"), "hi");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

/* Redesign: the prototype's computer layout: the side list is a column beside the conversation. */
test("a computer's window is unchanged: no bar, the side list where it always was", async (t) => {
  for (const [width, height] of [[1440, 950], [1024, 700]]) {
    const f = await signedIn(t, { width, height });
    await f.signIn();
    // The window draws again as its first reads arrive, so both are measured in one go once the side list has its width.
    await f.page.waitForFunction(() => document.getElementById("side")?.getBoundingClientRect().width > 0 && document.getElementById("prompt"));
    const [side, prompt] = await f.page.evaluate(() => ["side", "prompt"].map((id) => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { x: box.x, width: box.width };
    }));
    assert.ok(side.x >= 0 && side.width > 0, `${width}: the side list shows without being asked`);
    assert.ok(prompt.x >= side.x + side.width, `${width}: the conversation sits beside it`);
    assert.equal(await f.page.locator('[data-act="side"]').first().isVisible(), false, `${width}: no button to slide it over`);
    assert.equal(await noSideways(f.page), true);
    assert.deepEqual(f.errors, []);
  }
});

/* ---------- integration (phase2/everywhere): the first paint, the safe areas, one answer per question ---------- */

test("at every width from a phone to a wide screen nothing runs off sideways and nothing covers the message box", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  const sizes = [[390, 844], [560, 900], [561, 900], [699, 900], [700, 900], [760, 1000], [761, 1000], [800, 1200], [900, 1000], [1024, 700], [1440, 950]];
  for (const [width, height] of sizes) {
    await f.page.setViewportSize({ width, height });
    await f.page.waitForTimeout(300);
    const seen = await f.page.evaluate(() => {
      const prompt = document.getElementById("prompt").getBoundingClientRect();
      const top = document.elementFromPoint(prompt.left + prompt.width / 2, prompt.top + prompt.height / 2);
      const side = document.getElementById("side");
      return {
        sideways: document.documentElement.scrollWidth > innerWidth,
        covered: !document.querySelector(".dock").contains(top),
        docked: getComputedStyle(side).position !== "absolute" && side.getBoundingClientRect().left >= 0,
      };
    });
    assert.equal(seen.sideways, false, `${width}: nothing sideways`);
    assert.equal(seen.covered, false, `${width}: the text field is on top`);
    assert.equal(seen.docked, width > 760, `${width}: the side list is a column from 761 px, as the prototype's`);
  }
  assert.deepEqual(f.errors, []);
});

test("a quick double tap on a phone's big answer sends one answer, not two", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  const card = await ask(f.page);
  await f.page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.__branchApprovalRequests = 0;
    window.fetch = async (...args) => {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      if (target.endsWith("/api/policy/approve")) {
        window.__branchApprovalRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return original(...args);
    };
  });
  /* Three presses in the same instant (a thumb's double tap, then a slip onto Don't allow), so a slow machine cannot
     let the first answer come back before the others land. The card is found in the page at the moment of the presses:
     one found earlier can have been drawn anew in between, and presses on the old one reach nothing (seen on busy CI). */
  await card.waitFor();
  await f.page.evaluate(() => {
    const node = document.getElementById("live-ask");
    const yes = node.querySelector(".acts .btn.pri");
    const no = [...node.querySelectorAll(".acts button")].find((button) => button.textContent === "Don’t allow");
    yes.click();
    yes.click();
    no.click();
  });
  await f.page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  // WINDOW BUG: public/app/chat/chat.js answer() keeps the card's buttons live while an answer is on its way, so three
  // presses send three answers (two yeses and a no).
  assert.equal(await f.page.evaluate(() => window.__branchApprovalRequests), 1, "one answer left the phone");
  assert.deepEqual(f.errors, []);
});

test("an answer that could not be sent gives the buttons back; No is the quiet answer; a task somebody else started has no Yes, always", async (t) => {
  const f = await signedIn(t);
  /* The policy answer is rewritten on its way to the page before sign-in starts reading it, as if a chat app had
     started the task; nothing else about the question changes. */
  await f.page.route("**/api/policy", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, waiting: (body.waiting ?? []).map((question) => ({ ...question, source: "channel" })) } });
  });
  await f.signIn();
  const card = await ask(f.page);
  /* Read in the page, in one go, once the card's buttons are drawn and styled: buttons found first and read after can
     have been drawn anew in between, and a button no longer in the page has no colour (seen on busy CI). */
  const answers = await (await f.page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll("#live-ask .acts button")];
    if (buttons.length < 2 || !buttons.every((b) => getComputedStyle(b).backgroundColor)) return null;
    return buttons.map((b) => ({ text: b.textContent.trim(), live: b.getAttribute("aria-disabled") !== "true" && !b.disabled,
      pri: b.classList.contains("pri"), bg: getComputedStyle(b).backgroundColor }));
  })).jsonValue();
  assert.equal(answers.some((b) => /^Always allow/.test(b.text) && b.live), false, `no live standing yes: ${JSON.stringify(answers)}`);
  const yes = answers.find((b) => b.pri), no = answers.find((b) => b.text === "Don’t allow");
  assert.ok(yes?.live && no?.live, "a yes for now and a no");
  assert.notEqual(no.bg, yes.bg, "Don’t allow does not look like a yes");
  await f.page.route("**/api/policy/approve", (route) => route.fulfill({ status: 500, json: { error: "The computer did not answer." } }));
  await card.locator(".acts .btn.pri").tap();
  await f.page.locator(".toast").filter({ hasText: "The computer did not answer." }).waitFor({ timeout: 20000 });
  await f.page.locator("#live-ask .acts .btn.pri").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await f.page.locator("#live-ask .acts .btn.pri").isEnabled(), true, "it can be tried again");
  assert.equal(existsSync(join(f.workspace, "note.txt")), false, "nothing happened");
});
