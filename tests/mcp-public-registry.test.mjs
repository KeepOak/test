/* RES-135: searching the public MCP Registry (src/mcp-public-registry.ts) only reads: one fixed address, no redirects,
   a capped reply, entries checked before they are shown, deleted and malformed ones left out, nothing installed. */
import test from "node:test";
import assert from "node:assert/strict";
import { searchPublicRegistry } from "../dist/mcp-public-registry.js";

const entry = (name, extra = {}) => ({ server: { name, description: `${name} does things`, version: "1.2.3",
  packages: [{ registryType: "npm", identifier: `@example/${name.split("/")[1]}`, version: "1.2.3" }] }, ...extra });

test("a search reads the official registry once, and shows only well-formed entries that were not deleted", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), redirect: init.redirect });
    return Response.json({ servers: [
      entry("io.example/files"),
      entry("io.example/gone", { _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } }),
      { server: { name: "not a valid name!", description: "x", version: "1" } },
    ], metadata: { nextCursor: "next-page" } });
  };
  const found = await searchPublicRegistry({ search: "files" }, fetchImpl);
  assert.equal(asked.length, 1);
  const url = new URL(asked[0].url);
  assert.equal(url.origin + url.pathname, "https://registry.modelcontextprotocol.io/v0.1/servers");
  assert.equal(url.searchParams.get("search"), "files");
  assert.equal(asked[0].redirect, "error", "a redirect elsewhere is refused");
  assert.deepEqual(found.entries.map((one) => one.name), ["io.example/files"]);
  assert.equal(found.entries[0].packages[0].identifier, "@example/files");
  assert.equal(found.skipped, 2);
  assert.equal(found.nextCursor, "next-page");
});

test("an oversized or failed reply is refused in plain words", async () => {
  const huge = async () => new Response(JSON.stringify({ servers: [], pad: "x".repeat(600 * 1024) }));
  await assert.rejects(searchPublicRegistry({ search: "a" }, huge), /more data than allowed/);
  const down = async () => new Response("no", { status: 503 });
  await assert.rejects(searchPublicRegistry({ search: "a" }, down), /could not answer \(HTTP 503\)/);
  await assert.rejects(searchPublicRegistry({ search: "" }, down));
});
