import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";

/**
 * The other half of attachments: in the window itself, a document is attached to a message instead of
 * being refused with "use the Documents panel", and the file goes with the message rather than being
 * read out and thrown away.
 *
 * Local only: a scripted model, a server on its own port, and a headless browser.
 */

const owner = "local";

async function windowWithBranch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-ui-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Read it.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  closing.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, page, root, errors, server };
}

/* Redesign: the new window attaches through the message box's + menu, "Attach files" (data-act="attach"), which opens the
   system file picker; what waits to go shows as chips in #attached (public/app/chat/plus.js). */
async function attach(page, ...files) {
  await page.locator('[data-act="plusmenu"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('.pop [data-act="attach"]').click();
  await (await chooser).setFiles(files);
}
/* attach-anything: each file is sent ahead as soon as it is added, and waits as a chip (.att) with its preview. */
const chips = (page) => page.locator("#attached .att");
async function sendIt(page, words) {
  await page.locator("#prompt").fill(words);
  await page.locator("#send").click();
}
/** The conversation open in the side list. */
const openChat = (page) => page.waitForFunction(() => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id).then((h) => h.jsonValue());

test("in the window: a document goes with the message, and the conversation keeps it", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "roof.md");
  await writeFile(file, "# Roof\n\nFixed on Tuesday.\n", "utf8");

  await attach(page, file);
  await chips(page).getByText("roof.md").waitFor({ timeout: 10000 });

  await sendIt(page, "What does this say?");
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });

  const sessionId = await openChat(page);
  assert.ok(sessionId, "the message started a conversation");
  const message = app.store.messages(sessionId).find((one) => one.role === "user");
  assert.equal(message.attachments?.length, 1, "the document went with the message");
  assert.equal(message.attachments[0].kind, "document");
  assert.equal(message.attachments[0].name, "roof.md");
  assert.equal(message.attachments[0].mediaType, "text/markdown");

  // And it can be opened again, as the file it was.
  const kept = await app.attachments.read(sessionId, message.attachments[0].id);
  assert.match(kept.bytes.toString("utf8"), /Fixed on Tuesday/);
  assert.deepEqual(errors, []);
});

test("in the window: two films past the old 32 MB a message could carry both go, streamed ahead", async (t) => {
  const { page, errors } = await windowWithBranch(t);
  // attach-anything: files are sent ahead and written to disk as they arrive, so the old 32 MB per message is gone.
  const film = (name) => ({ name, mimeType: "video/mp4", buffer: Buffer.alloc(17 * 1024 * 1024) });
  await attach(page, film("first.mp4"));
  await attach(page, film("second.mp4"));
  await page.waitForFunction(() => document.querySelectorAll("#attached .att.ready").length === 2, null, { timeout: 30000 });
  const shown = await chips(page).allInnerTexts();
  assert.ok(shown.some((one) => one.includes("second.mp4")), `both films are on the message (${shown.join(" | ")})`);
  assert.deepEqual(errors, []);
});

test("in the window: the chips are cleared once the message is sent", async (t) => {
  const { page, root, errors } = await windowWithBranch(t);
  const file = join(root, "notes.txt");
  await writeFile(file, "a note", "utf8");

  await attach(page, file);
  await chips(page).getByText("notes.txt").waitFor({ timeout: 10000 });
  await sendIt(page, "Keep this.");
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });

  await chips(page).first().waitFor({ state: "detached", timeout: 10000 });
  assert.deepEqual(errors, []);
});

/** A real one-pixel PNG, so the page sees a picture rather than a file it calls a picture. */
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

test("what was said is shown exactly once, whether or not a file came with it", async (t) => {
  const { app, page, root, errors } = await windowWithBranch(t);
  const file = join(root, "roof.md");
  await writeFile(file, "# Roof" + "\n\n" + "Fixed on Tuesday." + "\n", "utf8");

  // An ordinary message, nothing attached. This is the one that was rendered twice.
  await sendIt(page, "Tell me about the roof.");
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });
  const sessionId = await openChat(page);
  const plain = await page.locator("#conversation .u").first().textContent();
  assert.equal(plain.split("Tell me about the roof.").length - 1, 1,
    `an ordinary message says what was said once, not twice (${plain})`);

  // And a message that does carry a file keeps its words, once.
  await page.waitForFunction(() => !document.querySelector("#conversation .typing"), null, { timeout: 20000 });
  await attach(page, file);
  await chips(page).getByText("roof.md").waitFor({ timeout: 10000 });
  await sendIt(page, "And what does this say?");
  await page.waitForFunction(() => document.querySelectorAll("#conversation .u").length === 2 && !document.querySelector("#conversation .typing"), null, { timeout: 20000 });
  const withFile = await page.locator("#conversation .u").last().textContent();
  assert.equal(withFile.split("And what does this say?").length - 1, 1,
    `a message with a file says what was said once (${withFile})`);
  // Redesign: replaced by the new window (prototype.html draws no card for a document beside a message's words), so the
  // card is not looked for; the file went with the message:
  assert.equal(app.store.messages(sessionId).findLast((one) => one.role === "user").attachments?.[0]?.name, "roof.md");

  // A reply that carries a file must not lose its words either. Put one in the conversation the way the store holds it,
  // then reopen the conversation the way a person comes back to it.
  const ref = app.store.messages(sessionId).findLast((one) => one.role === "user").attachments[0];
  app.store.message(sessionId, { role: "assistant", content: "Here it is again.", attachments: [ref] });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side .list [data-act="chat"][data-id="${sessionId}"]`).click();
  const reply = page.locator("#conversation .b").last();
  await reply.getByText("Here it is again.").waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
});

test("a picture goes with the message once: the page does not also send it to be looked at", async (t) => {
  const { page, root, errors } = await windowWithBranch(t);
  const file = join(root, "dot.png");
  await writeFile(file, onePixelPng);

  await attach(page, file);
  await chips(page).getByText("dot.png").waitFor({ timeout: 10000 });

  // A picture a person attached travels once, with the message; the server derives the model's copy from it. Sending it
  // twice doubled its bytes, and four legal pictures came to more than a message may weigh. Redesign: read from what the
  // new window really sends (POST /api/run), not from the old page's two lists.
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/run") && request.method() === "POST");
  await sendIt(page, "What is this?");
  const body = (await posted).postDataJSON();
  // attach-anything: the picture was sent ahead once; the message names it by its upload id and carries no bytes at all.
  assert.equal(body.uploads?.length, 1, "it travels once, sent ahead");
  assert.equal(body.attachments, undefined, "the message carries no copy of the file");
  assert.equal(body.images, undefined, "and no second copy to be looked at");
  assert.deepEqual(errors, []);
});

test("a temporary conversation's file opens from its own card, like any other", async (t) => {
  const { app, page, root, errors, server } = await windowWithBranch(t);
  const file = join(root, "dot.png");
  await writeFile(file, onePixelPng);

  // Started as temporary, so its files are kept in the temporary folder. Nothing the page sends says which folder to read
  // from — the conversation itself decides (src/attachments.ts). Temporary is chosen in the message box's + menu.
  await page.locator('[data-act="plusmenu"]').click();
  await page.locator(".pop #pm-temp").check();
  await page.keyboard.press("Escape");
  await attach(page, file);
  await chips(page).getByText("dot.png").waitFor({ timeout: 10000 });
  const ran = page.waitForResponse((response) => response.url().endsWith("/api/run") && response.request().method() === "POST");
  await sendIt(page, "Keep this for now.");
  // A temporary conversation is not listed in the side list; the engine's answer names it.
  const sessionId = (await (await ran).json()).sessionId;
  // The scripted model cannot look at pictures, so the task ends there; the message and its file are kept all the same.
  await page.waitForFunction(() => document.querySelector("#conversation .u") && !document.querySelector("#conversation .typing"), null, { timeout: 20000 });

  assert.equal(app.store.sessionTemporary(sessionId), true, "this really is a temporary conversation");
  // Redesign: replaced by the new window (prototype.html draws no card for a picture beside a message's words, so there is
  // no card to press); the file is kept with the temporary conversation and reads back byte for byte.
  const ref = app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const kept = await fetch(new URL(`/api/attachments/file?session=${sessionId}&id=${ref.id}`, server.url), { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(kept.status, 200);
  assert.deepEqual(Buffer.from(await kept.arrayBuffer()), onePixelPng);
  assert.deepEqual(errors, []);
});
