/* The owner's rule: in a Trunk's conversation everything is that Trunk's. The working dots, its reply, the steps it took
   and the "Done in" line carry its face, never Branch's mascot (the mascot is the logo only). The suggestion bar above
   the box carries a line icon, not the mascot. (public/app/chat/chat.js answerer/faceFor, chat/furniture.js, chat/rec.js) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const EMOJI = "🍄";
const ASK = "Look up the morels";
/* Branch's mascot in each form av() draws it: the moving figure (its /art/branch-* pictures) or the mark. */
const BRAND = /\bbrand\b|mark-face|mark-full|\/art\/branch/;

/** A model stand-in: the Trunk's question takes one step, then its answer waits for `release()`. */
function heldModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      if (!asked.includes(ASK)) return { content: "Hello, I find mushrooms.", toolCalls: [] };
      if (request.messages.at(-1)?.role !== "tool") return { content: "", toolCalls: [{ id: "look1", name: "memory.search", arguments: '{"query":"morels"}' }] };
      await gate;
      return { content: "Morels found.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}

test("a Trunk's conversation shows only that Trunk's face; the suggestion bar has no mascot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-own-face-"));
  const model = heldModel();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  t.after(async () => { model.release(); await context.close(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Morel", title: "Finds mushrooms", description: "" });
  await call(`/api/trunks/${trunk.id}`, { look: { face: "emoji", emoji: EMOJI } });
  await app.trunks.introduced();

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The engine offers its bar only in some setups; the window's drawing of it is what is checked here.
  await page.route("**/api/deployment/suggestion", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ bar: "background" }) }));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  const row = page.locator(`#side .list [data-act="chat"][data-id="${trunk.chatSessionId}"]`);
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await page.locator("#prompt").fill(ASK);
  await page.locator("#prompt").press("Enter");

  /* Its own face: the emoji pebble, never the brand's mark. */
  const isOwn = async (locator, what) => {
    await locator.first().waitFor({ timeout: 20000 });
    const html = await locator.first().innerHTML();
    assert.ok(html.includes(EMOJI), `${what} carries the Trunk's face: ${html}`);
    assert.ok(!BRAND.test(html),`${what} never carries Branch's mascot: ${html}`);
  };
  await isOwn(page.locator(".b:has(.typing) .gut, .b:has(.think) .gut"), "the working dots");
  model.release();
  await page.locator(".txt:has-text('Morels found.')").waitFor({ timeout: 20000 });
  await isOwn(page.locator(".b:has(.txt:has-text('Hello, I find mushrooms.')) .gut"), "its reply");
  /* The answer's steps open its turn and are signed with its face; the words after them continue that turn. */
  await isOwn(page.locator(".b:has(details.steps) .gut"), "the steps");
  await isOwn(page.locator(".done-line"), "the done line");
  assert.ok(!BRAND.test(await page.locator("#conversation").innerHTML()), "no mascot anywhere in its conversation");
  const guts = await page.locator("#main .b > .gut").evaluateAll((all) => all.map((g) => g.innerHTML).filter(Boolean));
  assert.ok(guts.length >= 2 && guts.every((html) => html.includes(EMOJI)), `every face in its conversation is its own: ${guts.length}`);

  const bar = page.locator(".recbar");
  await bar.waitFor({ timeout: 15000 });
  assert.equal(await bar.locator(".mark-face, .mark, .av").count(), 0, "the suggestion bar carries no face");
  assert.equal(await bar.locator(".ico-tile svg").count(), 1, "it carries a line icon");
  assert.deepEqual(errors, []);
});
