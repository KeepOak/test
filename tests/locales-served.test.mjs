import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { LANGUAGES } from "../public/i18n.js";
import { discardTemp } from "./temp-dir.mjs";

/* i18n-es: the engine serves its static files from a list, so a language listed in i18n.js LANGUAGES but missing from
   that list would load no words at all and the window would stay English under a Spanish <html lang>. */
test("the engine serves the words of every language the window lists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-locales-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  assert.ok(LANGUAGES.some((l) => l.id === "es"), "Spanish is listed");
  for (const { id } of LANGUAGES) {
    const response = await fetch(`${server.url}/locales/${id}.json`, { headers: { origin: server.url } });
    assert.equal(response.status, 200, `/locales/${id}.json is served`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const served = await response.json();
    const file = JSON.parse(await readFile(new URL(`../public/locales/${id}.json`, import.meta.url), "utf8"));
    assert.equal(Object.keys(served).length, Object.keys(file).length, `${id}.json arrives whole`);
  }
});
