// UI-106: Find in a conversation and conversations 1 to 9 are the engine's own rebindable shortcuts, so the owner can
// give them other keys and keep them; a saved record from before they existed still reads, and never clashes.
import test from "node:test";
import assert from "node:assert/strict";
import { ComfortKeysSchema, shortcutActions } from "../dist/comfort/settings.js";

test("find and conversations 1 to 9 are rebindable shortcuts with their usual keys", () => {
  const keys = ComfortKeysSchema.parse({});
  assert.equal(keys.findConversation, "Ctrl+F");
  for (let i = 1; i <= 9; i++) assert.equal(keys[`conversation${i}`], `Ctrl+${i}`);
  assert.ok(shortcutActions.includes("conversation9"));
  const moved = ComfortKeysSchema.parse({ conversation2: "Alt+2", findConversation: "Alt+F" });
  assert.equal(moved.conversation2, "Alt+2");
  assert.equal(moved.findConversation, "Alt+F");
});

test("a saved shortcut that already used Ctrl+1 keeps it and conversation 1 gives way", () => {
  const keys = ComfortKeysSchema.parse({ palette: "Ctrl+1" });
  assert.equal(keys.palette, "Ctrl+1");
  assert.equal(keys.conversation1, "");
  assert.equal(keys.conversation2, "Ctrl+2");
});
