/* PLAT-191: a part built on first use lists its tools from cards written at build time (src/tool-cards.ts,
   scripts/tool-cards.mjs). What a model sees must not change: the catalog listed from the cards is exactly the catalog
   the real tools give, every switch on; nothing of the part is loaded to list it; and a call loads it and runs the real
   tool. Mutation: change a word of a personal tool's description after the build (the cards say the old words) and the
   first case fails; register a card with no schema and the catalog loads the part. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { personalParts, personalTools } from "../dist/personal/settings.js";
import { cardSchema } from "../dist/tool-cards.js";
import { discardTemp } from "./temp-dir.mjs";

async function allOn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-tool-cards-"));
  const where = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  const first = await createBranch(where);
  for (const part of personalParts) await first.personal.setMode(part, { mode: "on" });
  await first.close();
  const app = await createBranch(where);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const names = personalParts.flatMap((part) => personalTools[part]);
const isCard = (app, name) => cardSchema in (app.registry.registered(name) ?? {});

test("the catalog listed from the cards is exactly the real tools' catalog, and listing it loads nothing", async (t) => {
  const app = await allOn(t);
  const everyone = new Set(app.registry.permissions());
  const fromCards = app.registry.descriptions(everyone, { diet: false });
  const dieted = app.registry.descriptions(everyone);
  assert.ok(names.every((name) => isCard(app, name)), "every personal tool is listed from its card");
  app.personal; // built now: its real tools take the cards' places
  assert.ok(names.every((name) => !isCard(app, name)), "the real tools are registered");
  assert.deepEqual(app.registry.descriptions(everyone, { diet: false }), fromCards, "the model sees the same tools, words and inputs");
  assert.deepEqual(app.registry.descriptions(everyone), dieted, "and the same once put on the schema diet");
});

test("a call to a listed tool builds the part and runs the real tool, checked as before", async (t) => {
  const app = await allOn(t);
  const tool = "chat.send_file";
  assert.ok(isCard(app, tool));
  await assert.rejects(app.registry.execute(tool, { nope: 1 }, app.runtime.context()), (error) => !/is not available/.test(error.message),
    "the call reaches the real tool, which checks its inputs");
  assert.equal(isCard(app, tool), false, "the part is built");
});
