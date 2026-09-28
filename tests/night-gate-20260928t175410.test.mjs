/** SELF-314 night gate: a ChatGPT connection's preset id keeps the model's dots (src/chatgpt-presets.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { chatgptPresetId } from "../dist/chatgpt-presets.js";

test("night gate: a ChatGPT preset id keeps the model's dots", () => {
  assert.equal(chatgptPresetId("gpt-5.6-terra"), "chatgpt-gpt-5-6-terra");
});
