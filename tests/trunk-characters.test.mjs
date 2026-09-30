/**
 * Trunk look: the characters a Trunk can wear come from the art Branch ships (src/trunks/characters.ts), never a list kept
 * by hand. Every folder under public/art/agents is one manifest entry, every file a character names is on disk, the order
 * follows manifest-A, B and C. Branch is the logo only. GET /api/trunks hands the catalogue to the window, and a
 * Trunk keeps its eyes beside its look. Without a browser; a scripted model, nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixture, on } from "./trunks-helpers.mjs";
import { characters } from "../dist/trunks/characters.js";
import { trunkCharacters } from "../dist/trunks/record.js";
import { trunksApi } from "../dist/trunks/api.js";

const art = fileURLToPath(new URL("../public/art/", import.meta.url));

test("every character folder is in exactly one manifest, and every file a character names is on disk", () => {
  const folders = readdirSync(`${art}agents`, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const listed = characters().map((c) => c.id);
  assert.deepEqual(listed.slice().sort(), folders, "one character per folder, none missing");
  assert.ok(!listed.includes("branch"), "the Branch mascot is not a Trunk character");
  assert.equal(new Set(listed).size, listed.length, "no character twice");
  assert.equal(listed[0], "ember", "manifest-A first in its order");
  assert.deepEqual(listed.slice(-3), ["sorrel", "skein", "nib"], "pass 17's three last, as the prototype adds them");
  for (const c of characters()) {
    assert.ok(c.name && c.states.idle, `${c.id} has a name and an idle loop`);
    for (const file of [c.still, ...Object.values(c.states)]) {
      assert.match(file, /^\/art\/[a-z0-9/_.-]+$/, `${c.id}: ${file} is an address under /art/`);
      assert.ok(existsSync(`${art}${file.slice(5)}`), `${c.id}: ${file} is on disk`);
    }
  }
  assert.deepEqual([...trunkCharacters], listed, "the engine accepts exactly the catalogue");
});

test("every character's loops come in the smaller sizes the window draws its faces at", () => {
  for (const c of characters()) {
    assert.deepEqual(c.sizes, [96, 160], `${c.id}: its smaller encodes`);
    for (const file of Object.values(c.states))
      for (const width of c.sizes) assert.ok(existsSync(`${art}${file.slice(5).replace(/\.webm$/, `.${width}.webm`)}`), `${c.id}: ${file} at ${width}px is on disk`);
  }
});

test("GET /api/trunks hands the window the catalogue; a Trunk wears any of it and keeps its eyes", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const answer = await trunksApi({ trunks: app.trunks, method: "GET", readBody: async () => ({}), person: null, requireOwner: () => {} }, "/api/trunks");
  assert.deepEqual(answer.characters.map((c) => c.id), characters().map((c) => c.id));
  const ada = app.trunks.create({ name: "Ada" });
  for (const character of ["kite", "bolt", "nib"]) assert.equal(app.trunks.edit(ada.id, { character }).character, character);
  assert.throws(() => app.trunks.edit(ada.id, { character: "branch" }), undefined, "Branch remains the logo only");
  assert.throws(() => app.trunks.edit(ada.id, { character: "classic" }), undefined, "the pebble is null, not a name");
  assert.equal(app.trunks.edit(ada.id, { eyes: "sleepy" }).eyes, "sleepy");
  assert.equal(app.trunks.edit(ada.id, { name: "Ada Two" }).eyes, "sleepy", "an edit without eyes keeps them");
  assert.throws(() => app.trunks.edit(ada.id, { eyes: "closed" }));
  assert.equal(app.trunks.edit(ada.id, { eyes: null }).eyes, null, "null is round again");
});

test("a saved legacy mascot choice cannot prevent editing the Trunk or change its identity", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const made = app.trunks.create({ name: "Legacy" });
  const trunk = app.trunks.edit(made.id, { instructions: "Keep my instructions." });
  app.store.save("governance", app.runtime.owner, `trunk:${trunk.id}`, { ...trunk, character: "branch" });
  const changed = app.trunks.edit(trunk.id, { title: "My notes" });
  assert.equal(changed.id, trunk.id);
  assert.equal(changed.chatSessionId, trunk.chatSessionId);
  assert.equal(changed.instructions, trunk.instructions);
  assert.equal(changed.title, "My notes");
  assert.equal(changed.character, null);
  assert.equal(app.store.get("governance", app.runtime.owner, `trunk:${trunk.id}`).data.character, null);
});
