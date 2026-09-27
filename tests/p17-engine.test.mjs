/**
 * Pass 17's engine side (#337), pinned without a browser: a Trunk wears one of the painted characters Branch
 * draws or the pebble, and never a name the window would build a path or markup from; and delight takes the
 * six picture pets, keeping what was already earned when the owner has tried every pet. A scripted model;
 * nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { trunkCharacters } from "../dist/trunks/record.js";
import { petKinds } from "../dist/achievements.js";
import { achievementsView, delightSettings, notice, saveDelightSettings } from "../dist/delight.js";

test("pass 17: a Trunk keeps the character it wears, refuses one Branch does not draw, and null gives the pebble back", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  assert.equal(ada.character ?? null, null, "a new Trunk wears the pebble");
  for (const character of trunkCharacters) assert.equal(app.trunks.edit(ada.id, { character }).character, character);
  // The window builds /art/agents/<id>/ from this value, so anything outside the list is refused, not stored.
  for (const character of ["../../secrets", "<img src=x onerror=alert(1)>", "Sorrel", ""])
    assert.throws(() => app.trunks.edit(ada.id, { character }), undefined, JSON.stringify(character));
  assert.equal(app.trunks.edit(ada.id, { character: null }).character, null, "null is the pebble again");
  // A Trunk's file carries the character it wears, and a file cannot bring in one Branch does not draw.
  app.trunks.edit(ada.id, { character: "skein" });
  const file = app.trunks.exportFile(ada.id);
  assert.equal(file.trunk.character, "skein");
  assert.equal(app.trunks.importFile(file).character, "skein");
  assert.throws(() => app.trunks.importFile({ ...file, trunk: { ...file.trunk, character: "../../secrets" } }));
});

test("pass 17: delight takes the six picture pets, refuses a kind it does not draw, and keeps what was earned once every pet is tried", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  assert.equal(petKinds.length, 49, "the eight drawn pets, the six picture pets of pass 17, Little Branch and the 34 painted pets");
  // Something earned before the pets are tried, which a record that no longer reads would lose.
  saveDelightSettings(app.store, owner, { achievements: { on: true } });
  notice(app.store, owner, { what: "pat" });
  const before = achievementsView(app.store, owner);
  const earned = before.list.filter((a) => a.got).map((a) => a.id);
  assert.ok(earned.includes("noticed:pats:1"), "a pat is earned");
  for (const kind of petKinds) {
    saveDelightSettings(app.store, owner, { pets: { on: true, kind } });
    assert.equal(delightSettings(app.store, owner).pets.kind, kind, kind);
  }
  assert.throws(() => saveDelightSettings(app.store, owner, { pets: { kind: "dragon" } }), undefined, "a kind Branch does not draw");
  assert.equal(delightSettings(app.store, owner).pets.kind, petKinds.at(-1), "a refused kind changes nothing");
  const after = achievementsView(app.store, owner);
  const still = new Set(after.list.filter((a) => a.got).map((a) => a.id));
  for (const id of earned) assert.ok(still.has(id), `${id} is still earned after all ${petKinds.length} pets were tried`);
  const noticed = app.store.get("settings", owner, "delight-achievements").data.noticed.pets;
  assert.deepEqual([...noticed].sort(), [...petKinds].sort(), "every pet is noticed once");
});
