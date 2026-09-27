/* The terminal's two key lines, word for word as the approved sample has them, and only keys the
   drawn view really answers to: Escape then a digit, Alt and a digit, Ctrl+K and / each do what the
   second line says. */
import test from "node:test";
import assert from "node:assert/strict";
import { helpLines } from "../dist/terminal-command-table.js";
import { routeKey } from "../dist/terminal-keys.js";
import { loadWords } from "../dist/terminal-words.js";

const LINE1 = "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves";
const LINE2 = "Esc, then 1-6 (or Alt+1 to Alt+6): Conversation, Inbox, Automations, Library, Customize, Team · Ctrl+K or /: find anything";

test("help opens with both key lines, in English and in French", () => {
  assert.deepEqual(helpLines(loadWords("en")).slice(0, 2), [LINE1, LINE2]);
  const french = helpLines(loadWords("fr")).slice(0, 2);
  assert.match(french[0], /^Entrée envoie · Alt\+Entrée ajoute une ligne/);
  assert.match(french[1], /^Échap, puis 1-6 \(ou Alt\+1 à Alt\+6\) : Conversation, Boîte de réception, Automatisations, Bibliothèque, Personnaliser, Équipe/);
});

test("every key the second line names does what it says", () => {
  const did = [];
  const tui = { route: { place: "chat", tab: "" }, focus: "composer", overlay: null, editor: { text: "" }, conversation: { awaiting: false },
    requestDraw() {}, goPlace: (n) => did.push(`place ${n}`), openPalette: (seed) => did.push(`find ${seed ?? ""}`.trim()),
    keys() {}, togglePane() {}, newConversation() {} };
  routeKey(tui, undefined, { name: "escape" });
  assert.equal(tui.focus, "tabs", "Esc steps out of the message box");
  routeKey(tui, "3", { name: "3" });
  routeKey(tui, undefined, { name: "5", meta: true });
  routeKey(tui, undefined, { name: "k", ctrl: true });
  tui.focus = "composer";
  routeKey(tui, "/", { name: "/" });
  assert.deepEqual(did, ["place 3", "place 5", "find", "find /"]);
});
