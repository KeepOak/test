/**
 * Q195 (NAS 545cb4d): the working card and its question are shown under the conversation (dogfood B4), so they come
 * after it in the page too, and Tab and a screen reader meet them where they are seen, not before the conversation.
 *
 * Redesign: the old page's #live-row and #plan-controls (public/index.html) are replaced by the new window's thread
 * (public/app/chat/chat.js draw and thread), 1:1 with prototype.html, where the question is an ask card and the
 * working card is the typing row, both drawn inside #conversation after the messages. The plan is drawn in the flow as
 * a block of its own (planBlock), not as a row of controls under the working card, so that clause went with the old page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the live row comes after the conversation in the page, as it is shown", async () => {
  const chat = await readFile(new URL("../public/app/chat/chat.js", import.meta.url), "utf8");
  const draw = /export function draw\(\) \{[\s\S]*?\n\}/.exec(chat)?.[0] ?? "";
  const at = (text, marker) => { const index = text.indexOf(marker); assert.ok(index >= 0, marker); return index; };
  assert.ok(at(draw, "emptyChat()") < at(draw, 'id="conversation"'), "control: the greeting, or the conversation");
  assert.ok(at(draw, 'id="conversation"') < at(draw, "composer()"), "the conversation, then the message box");
  const thread = /function thread\(\) \{[\s\S]*?\n\}/.exec(chat)?.[0] ?? "";
  const drawn = /return marks\.start \+ ([^;]+);/.exec(thread)?.[1] ?? "";
  assert.ok(drawn, "the thread's markup is one expression");
  assert.ok(at(drawn, 'rows.join("")') < at(drawn, 'asks.join("")'), "the question after the conversation's messages");
  assert.ok(at(drawn, 'asks.join("")') < at(drawn, "typing"), "and the working card after the question, last, as they are shown");
  assert.match(thread, /id="live-ask"|askCard/, "the question is the thread's ask card");
  assert.match(chat, /<div class="card ask" id="live-ask">/);
});
