import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { writeWav } from "../dist/media-audio.js";
import { signIn } from "./new-window-places.mjs";

/** Q85 (FQ-surfaces.playback): a clip goes to the message the server saved for this send, the id
 *  POST /api/run returns as `userMessageId`, and never to a message a linked chat saved in between.
 *  Redesign: the new window no longer matches clips to messages in the page (the old public/playback.js). It sends the
 *  file with the message (POST /api/run attachments, public/app/chat/plus.js), the server keeps it on the message it
 *  saved for this send, and the conversation draws a player from each message's own attachments
 *  (public/app/chat/media.js mediaRows). So the real server is driven the way the window drives it, and every message
 *  it saved is drawn by the window's own mediaRows in a signed-in page. */

/** One second of silence at 8 kHz, so nothing here depends on a real recording. */
const silentWav = () => writeWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 }, Buffer.alloc(16000));
const clip = () => ({ mediaType: "audio/wav", name: "note.wav", data: silentWav().toString("base64") });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-playback-own-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Heard it.", toolCalls: [] }; } },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: "Bearer " + server.token, "content-type": "application/json", origin: server.url };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
    assert.equal(response.status, 200, `${path} answers`);
    return response.json();
  };
  await call("/api/onboarding", { done: true });
  /** A signed-in window of its own, which has never drawn the conversation. */
  const page = async () => {
    const one = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    await signIn(one, server);
    return one;
  };
  return { app, call, page };
}

/** Sends as the window does, then draws every user message the server saved with the window's own mediaRows. */
async function sendAndDraw(page, call, body) {
  const run = await call("/api/run", body);
  const view = await call("/api/sessions/" + run.sessionId);
  const users = view.messages.filter((entry) => entry.role === "user");
  const drawn = await page.evaluate(async ({ messages, session }) => {
    const { mediaRows } = await import("/app/chat/media.js");
    return messages.map((message) => {
      const box = document.createElement("div");
      box.innerHTML = mediaRows(message, session);
      return [...box.querySelectorAll(".media15")].map((card) => (card.classList.contains("video") ? "video" : "audio"));
    });
  }, { messages: users, session: run.sessionId });
  // The server writes what was attached after the words ("[attached file: note.wav (sound)]", src/runtime.ts), so a
  // message is known by its own words.
  const bubbles = new Map(users.map((source, index) => [source.content.split("\n\n[attached")[0], { id: source.messageId, players: drawn[index] }]));
  return { run, bubbles };
}

test("a clip goes to this send's own saved message, not to one a linked chat saved in between", async (t) => {
  const { app, call, page } = await fixture(t);
  const tab = await page();
  const first = await sendAndDraw(tab, call, { prompt: "first, with no file" });
  const sessionId = first.run.sessionId;
  // A linked chat shares this conversation's history (src/channels/router.ts): it saves a message
  // after this page's last redraw and before the next send is saved.
  app.store.message(sessionId, { role: "user", content: "from the linked chat" });
  const second = await sendAndDraw(tab, call, { prompt: "second, with a note", sessionId, attachments: [clip()] });

  assert.equal(second.run.sessionId, sessionId, "the run's own fields are still there");
  assert.equal(second.run.status, "completed");
  const older = second.bubbles.get("first, with no file");
  const linked = second.bubbles.get("from the linked chat");
  const own = second.bubbles.get("second, with a note");
  assert.equal(typeof second.run.userMessageId, "number", "POST /api/run says which message it saved");
  assert.equal(second.run.userMessageId, own.id, "and it is the one the conversation shows for this send");
  assert.ok(older.id < linked.id && linked.id < own.id, "the linked chat's message was saved in between");
  assert.deepEqual(linked.players, [], "the linked chat's message never takes this send's clip");
  assert.deepEqual(own.players, ["audio"], "this send's own message plays it");
  assert.deepEqual(older.players, []);

  // A page that never drew this conversation gives the clip to this send's message, not an older one.
  const third = await sendAndDraw(await page(), call, { prompt: "third, from a page that never drew it", sessionId, attachments: [clip()] });
  assert.deepEqual(third.bubbles.get("third, from a page that never drew it").players, ["audio"]);
  assert.deepEqual(third.bubbles.get("first, with no file").players, []);
  assert.deepEqual(third.bubbles.get("from the linked chat").players, []);
  assert.deepEqual(third.bubbles.get("second, with a note").players, ["audio"], "and the earlier send keeps its own");
});
