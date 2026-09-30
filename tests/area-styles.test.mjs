/* New window styles live in public/app/styles/<area>.css, each linked once from public/index.html right after app.css,
   in a block sorted by name: the same place in the cascade as the end of app.css, where parallel pull requests used to
   append and collide. Every area file is linked, and every link names a file that exists.
   Mutation: add a file to public/app/styles without its link, or put the links out of order, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

test("area stylesheets are linked after app.css, sorted, one each, and all exist", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(links[0], "/app.css", "app.css comes first");
  const areas = links.slice(1);
  assert.ok(areas.every((href) => /^\/app\/styles\/[a-z0-9-]+\.css$/.test(href)), `only area files follow app.css: ${areas}`);
  assert.deepEqual(areas, [...areas].sort(), "the area links are sorted by name");
  assert.equal(new Set(areas).size, areas.length, "each area is linked once");
  const files = (await readdir(new URL("../public/app/styles/", import.meta.url))).filter((name) => name.endsWith(".css")).map((name) => `/app/styles/${name}`);
  assert.deepEqual(areas, [...files].sort(), "every area file is linked, and every link has its file");
});
