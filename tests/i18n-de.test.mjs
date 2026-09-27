import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { LOOK_LANGUAGES } from "../dist/terminal-theme.js";
import { delightRoute } from "../dist/delight.js";
import { achievementCatalogue } from "../dist/achievements.js";
import { inGerman } from "../dist/achievements-de.js";

/*
 * i18n-de: German is a language Branch really speaks, not only a file. The engine takes "de" for the look setting and
 * serves its words, the achievements are worded in German when the window asks in German, and the models offered for
 * this computer describe themselves in German.
 */
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-i18n-de-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("every language the look setting takes has its words served, German among them, and nothing else is", async (t) => {
  const { app, root } = await workspace(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  assert.ok(LOOK_LANGUAGES.includes("de"), "German is one of the look setting's languages");
  for (const code of LOOK_LANGUAGES) {
    const response = await fetch(`${server.url}/locales/${code}.json`);
    assert.equal(response.status, 200, `${code}.json is served without a session`);
    const words = await response.json();
    assert.equal(typeof words["window.setup.label"], "string", `${code}.json is the real file`);
  }
  assert.equal((await fetch(`${server.url}/locales/de.json`).then((r) => r.json()))["window.setup.label"], "Branch einrichten");
  assert.equal((await fetch(`${server.url}/locales/xx.json`)).status === 200, false, "a language with no file is not served");
  const look = await fetch(`${server.url}/api/look`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url },
    body: JSON.stringify({ language: "de" }),
  });
  assert.equal(look.status, 200);
  assert.equal((await look.json()).language, "de", "POST /api/look takes German");
});

test("the achievements come in German when the window asks in German, the same ones in the same order", async (t) => {
  const { app } = await workspace(t);
  await delightRoute(app, "POST", "/api/delight/settings", async () => ({ achievements: { on: true } }));
  const view = (language) => delightRoute(app, "GET", "/api/delight/achievements", async () => ({}), language);
  const byId = (list, id) => list.find((a) => a.id === id);
  const german = await view("de"), english = await view(null);
  assert.deepEqual(byId(german.list, "tasks:1"), { ...byId(english.list, "tasks:1"), name: "Keimling", desc: "1 Aufgabe erledigen.", kind: "Erste Schritte" });
  assert.deepEqual(german.list.map((a) => [a.id, a.tier]), english.list.map((a) => [a.id, a.tier]));
  const same = achievementCatalogue().filter((a) => inGerman(a).desc === a.desc);
  assert.deepEqual(same, [], "every sentence is German");
  const pet = achievementCatalogue().find((a) => a.id === "noticed:pet:redpanda:1");
  assert.deepEqual([inGerman(pet).name, inGerman(pet).desc], ["Begegnung mit dem Roten Panda", "Den Roten Panda als Haustier wählen."]);
  assert.equal(inGerman(achievementCatalogue().find((a) => a.id === "tasks:1000")).name, "1.000 Aufgaben erledigt", "numbers are written the German way");
});

test("the models offered for this computer describe themselves in German too", async () => {
  const list = JSON.parse(await readFile(new URL("../data/local-models.json", import.meta.url), "utf8"));
  for (const model of list.models) {
    assert.equal(typeof model.summary.de, "string", `${model.id} has German words`);
    assert.notEqual(model.summary.de, model.summary.en, `${model.id}'s German is not its English`);
  }
});
