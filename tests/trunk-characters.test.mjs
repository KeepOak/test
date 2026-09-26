/**
 * Trunk look: the characters a Trunk can wear come from the art Branch ships (src/trunks/characters.ts), never a list kept
 * by hand. Every folder under public/art/agents is one manifest entry, every file a character names is on disk, the order
 * is the prototype's (Branch's spirit, then manifest-A, B and C), GET /api/trunks hands the catalogue to the window, and a
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
  assert.deepEqual(listed.filter((id) => id !== "branch").sort(), folders, "one character per folder, none missing");
  assert.equal(new Set(listed).size, listed.length, "no character twice");
  assert.deepEqual(listed.slice(0, 2), ["branch", "ember"], "Branch's spirit first, then manifest-A in its order");
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

test("GET /api/trunks hands the window the catalogue; a Trunk wears any of it and keeps its eyes", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const answer = await trunksApi({ trunks: app.trunks, method: "GET", readBody: async () => ({}), person: null, requireOwner: () => {} }, "/api/trunks");
  assert.deepEqual(answer.characters.map((c) => c.id), characters().map((c) => c.id));
  const ada = app.trunks.create({ name: "Ada" });
  for (const character of ["branch", "kite", "bolt", "nib"]) assert.equal(app.trunks.edit(ada.id, { character }).character, character);
  assert.throws(() => app.trunks.edit(ada.id, { character: "classic" }), undefined, "the pebble is null, not a name");
  assert.equal(app.trunks.edit(ada.id, { eyes: "sleepy" }).eyes, "sleepy");
  assert.equal(app.trunks.edit(ada.id, { name: "Ada Two" }).eyes, "sleepy", "an edit without eyes keeps them");
  assert.throws(() => app.trunks.edit(ada.id, { eyes: "closed" }));
  assert.equal(app.trunks.edit(ada.id, { eyes: null }).eyes, null, "null is round again");
});
