import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { delightRoute } from "../dist/delight.js";
import { achievementCatalogue } from "../dist/achievements.js";
import { inSpanish } from "../dist/achievements-es.js";

/*
 * i18n-es: the achievements are worded in Spanish when the window asks in Spanish, as they are in French and German,
 * and the models offered for this computer describe themselves in Spanish.
 */
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-i18n-es-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("the achievements come in Spanish when the window asks in Spanish, the same ones in the same order", async (t) => {
  const app = await workspace(t);
  await delightRoute(app, "POST", "/api/delight/settings", async () => ({ achievements: { on: true } }));
  const view = (language) => delightRoute(app, "GET", "/api/delight/achievements", async () => ({}), language);
  const byId = (list, id) => list.find((a) => a.id === id);
  const spanish = await view("es"), english = await view(null);
  assert.deepEqual(byId(spanish.list, "tasks:1"), { ...byId(english.list, "tasks:1"), name: "Brote", desc: "Terminar 1 tarea.", kind: "Primeros pasos" });
  assert.deepEqual(spanish.list.map((a) => [a.id, a.tier]), english.list.map((a) => [a.id, a.tier]));
  assert.equal(achievementCatalogue().length, 505);
  assert.deepEqual(achievementCatalogue().filter((a) => inSpanish(a).desc === a.desc).map((a) => a.id), [], "every sentence is Spanish");
  const pet = achievementCatalogue().find((a) => a.id === "noticed:pet:squirrel:1");
  assert.deepEqual([inSpanish(pet).name, inSpanish(pet).desc], ["Encuentro con la ardilla", "Elegir a la ardilla como mascota."]);
  const million = achievementCatalogue().find((a) => a.id === "sss:tasks");
  assert.equal(inSpanish(million).desc, `Terminar ${(1000000).toLocaleString("es-ES")} tareas.`, "numbers are written the Spanish way");
});

test("the models offered for this computer describe themselves in Spanish too", async () => {
  const list = JSON.parse(await readFile(new URL("../data/local-models.json", import.meta.url), "utf8"));
  for (const model of list.models) {
    assert.equal(typeof model.summary.es, "string", `${model.id} has Spanish words`);
    assert.notEqual(model.summary.es, model.summary.en, `${model.id}'s Spanish is not its English`);
  }
});
