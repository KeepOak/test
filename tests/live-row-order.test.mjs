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
  const whole = /export function draw\(\) \{[\s\S]*?\n\}/.exec(chat)?.[0] ?? "";
  // Pass 18a/18b: a helper's or room member's conversation returns early, view only; the page as the owner sees it is
  // the last return.
  const draw = whole.slice(whole.lastIndexOf("\n  return "));
  const at = (text, marker) => { const index = text.indexOf(marker); assert.ok(index >= 0, marker); return index; };
  assert.ok(at(draw, "emptyChat()") < at(draw, 'id="conversation"'), "control: the greeting, or the conversation");
  assert.ok(at(draw, 'id="conversation"') < at(draw, "composer()"), "the conversation, then the message box");
  const thread = /function thread\(\) \{[\s\S]*?\n\}/.exec(chat)?.[0] ?? "";
  // The thread's rows are gathered in T.out (a room's look among them), and its ask cards in `asks`.
  const drawn = /\n  return ([^;]*marks\.start[^;]*);/.exec(thread)?.[1] ?? "";
  assert.ok(drawn, "the thread's markup is one expression");
  assert.ok(at(drawn, "marks.start") < at(drawn, 'T.out.join("")'), "the conversation's messages");
  assert.ok(at(drawn, 'T.out.join("")') < at(drawn, "asks"), "the question after the conversation's messages");
  assert.ok(at(drawn, "asks") < at(drawn, "typing"), "and the working card after the question, last, as they are shown");
  // A paused task's card (long-work) sits between the question and the working card, which stays last. It is left out
  // while a message is on its way, or while its Resume is already shown elsewhere (cardResumes).
  assert.match(drawn, /asks \+ (?:\(C\.sending(?: \|\| cardResumes\(\))? \? "" : pausedCard\([^)]*\)\) \+ )?typing$/, "the working card is last");
  assert.match(thread, /id="live-ask"|askCard/, "the question is the thread's ask card");
  assert.match(chat, /<div class="card ask" id="live-ask">/);
});
