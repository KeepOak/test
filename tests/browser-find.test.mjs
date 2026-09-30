/* SCREEN-166 (find by words): browser.find matches the literal words of an element's label, with an optional role such
   as "the Save button", never guesses synonyms, and never offers a password box. The matcher only; no browser runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { FindSchema, matchingMarks } from "../dist/integrations/browser-find.js";

const marks = [
  { id: 1, role: "button", name: "Save changes", key: "a" },
  { id: 2, role: "link", name: "Save for later", key: "b" },
  { id: 3, role: "input:text", name: "Search the shop", key: "c" },
  { id: 4, role: "input:password", name: "Password", key: "d" },
  { id: 5, role: "input:submit", name: "Send", key: "e" },
];
const ids = (description) => matchingMarks(marks, description).map((mark) => mark.id);

test("SCREEN-166: label words and an optional role pick the element; no synonyms are guessed", () => {
  assert.deepEqual(ids("the Save button"), [1]);
  assert.deepEqual(ids("save"), [1, 2], "without a role both are offered, so the caller sees it is ambiguous");
  assert.deepEqual(ids("the Save link"), [2]);
  assert.deepEqual(ids("search field"), [3]);
  assert.deepEqual(ids("the Send button"), [5], "a submit input counts as a button");
  assert.deepEqual(ids("store changes"), [], "no inferred synonyms");
  assert.deepEqual(ids("password"), [], "a password box is never offered");
  assert.throws(() => matchingMarks(marks, "the button"), /Include the words on the element/);
});

test("SCREEN-166: a description is 1-300 characters and at most ten results are asked for", () => {
  assert.equal(FindSchema.parse({ description: "Save" }).limit, 5);
  for (const bad of [{ description: "" }, { description: "x".repeat(301) }, { description: "Save", limit: 11 }, { description: "Save", click: true }])
    assert.equal(FindSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 50));
});
