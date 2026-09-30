/* CHAT-041: /verbose sets how much of each step one direct chat is shown, without touching the app's setting or any
   other chat; "default" hands the chat back to the app's setting. */
import test from "node:test";
import assert from "node:assert/strict";
import { stepsInChat, verboseInChat } from "../dist/channels/steps-display.js";

function memoryStore() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.has(id) ? { data: rows.get(id) } : undefined,
    save: (_t, _o, id, data) => { rows.set(id, data); }, delete: (_t, _o, id) => rows.delete(id) };
}

test("/verbose cycles this chat's level, takes a named one, and default follows the app again", () => {
  const store = memoryStore(), app = { detail: "new", cleanup: false, noEdit: "summary" };
  const level = (chatId) => stepsInChat(store, "local", "telegram", chatId, app).detail;
  assert.match(verboseInChat(store, "local", "telegram", "1", "", app), /every step\./, "new → all");
  assert.equal(level("1"), "all");
  verboseInChat(store, "local", "telegram", "1", "", app);
  assert.equal(level("1"), "verbose");
  verboseInChat(store, "local", "telegram", "1", "", app);
  assert.equal(level("1"), "off", "and round again");
  verboseInChat(store, "local", "telegram", "1", "full", app);
  assert.equal(level("1"), "verbose");
  assert.equal(level("2"), "new", "another chat keeps the app's level");
  assert.match(verboseInChat(store, "local", "telegram", "1", "loud", app), /Use \/verbose off, new, all, full or default/);
  assert.match(verboseInChat(store, "local", "telegram", "1", "default", app), /follow this app's settings again/);
  assert.equal(level("1"), "new");
});
