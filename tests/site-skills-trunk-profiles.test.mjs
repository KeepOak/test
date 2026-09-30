/**
 * Settings › Computer & browser: Site skills and Browser profiles that stay signed in, per Trunk.
 * - GET /api/browser/site-skills (the owner's, requireOwner) lists the websites the switched-on skills know, each with the skill it came from
 *   and its revision; Forget is the ordinary skill removal at that revision.
 * - A Trunk keeps its own browser profile (browser.profile "keep"): its next task opens with that sign-in, and no other
 *   Trunk, nor Branch itself, can use, make, remove or even list it.
 *
 * Mutation notes (each turns this file red):
 * - browser.ts trunkProfile: drop the `!context.trunk` check, or load any saved one -> "Branch itself never opens it" fails.
 * - browser.ts keepForTrunk: drop the other-sign-in refusal                        -> "never copies it" fails.
 * - browser.ts profileAction: drop the other-Trunk refusal                         -> "another Trunk cannot use it" fails.
 * - browser.ts profileAction list: drop the Trunk filter                           -> "nor list it" fails.
 * - browser-sites.ts siteSkillsFrom: drop passing the skill id                    -> "Forget names the skill" fails.
 * - browser.ts tab: open a tab without the Trunk's profile                         -> "a tab opened first" fails.
 * - trunks/index.ts remove: drop onRemoved                                         -> "hers is gone" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright"; // this file drives a real browser, so it runs in the browser group (tests/browser-tests-declared.test.mjs)
import { BranchBrowser, registerBrowser, trunkProfileName } from "../dist/integrations/browser.js";
import { BrowserProfiles } from "../dist/integrations/browser-profiles.js";
import { siteSkillsFrom } from "../dist/integrations/browser-sites.js";
import { packSkill } from "../dist/skill-package.js";
import { ToolRegistry, Budget, createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const key = { key: async () => Buffer.alloc(32, 7) };
const context = (runId, trunk) => ({ owner: "test", workspace: ".", runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(["browser.read", "browser.interact"]), depth: 0, ...(trunk ? { trunk } : {}) });

async function site() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname, signed = /sid=kept/.test(request.headers.cookie ?? "");
    if (path === "/login") response.setHeader("set-cookie", "sid=kept; Path=/; Max-Age=3600");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>t</title><p id="who">${path === "/login" || signed ? "signed in" : "signed out"}</p>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(resolve)) };
}

test("a Trunk keeps its own browser profile; no other Trunk and not Branch itself can reach it", async (t) => {
  assert.ok(chromium, "a real browser");
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-profiles-"));
  const { origin, stop } = await site();
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.profiles = new BrowserProfiles(join(root, "profiles"), key);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  t.after(async () => { await browser.close(); await stop(); await rm(root, { recursive: true, force: true }); });
  const who = async (ctx) => {
    await registry.execute("browser.navigate", { url: `${origin}/whoami` }, ctx);
    const read = await registry.execute("browser.extract", { selector: "#who", limit: 1 }, ctx);
    await registry.finishRun(ctx);
    return read.rows[0].text;
  };
  const ada = "0a1b2c3d-1111-4222-8333-444455556666", ben = "9f8e7d6c-1111-4222-8333-444455556666";

  await assert.rejects(registry.execute("browser.profile", { action: "keep" }, context("r0")), /Only a Trunk keeps/);
  const first = context("r1", ada);
  await registry.execute("browser.navigate", { url: `${origin}/login` }, first);
  const kept = await registry.execute("browser.profile", { action: "keep" }, first);
  assert.equal(kept.keeping, true);
  await registry.finishRun(first);
  assert.equal(await who(context("r2", ada)), "signed in", "Ada's next task opens with her own sign-in");
  // A task whose first step opens a tab (not a page) still opens the window with her sign-in.
  const tabFirst = context("r2b", ada);
  await registry.execute("browser.tab", { action: "open" }, tabFirst);
  await registry.execute("browser.navigate", { url: `${origin}/whoami` }, tabFirst);
  assert.equal((await registry.execute("browser.extract", { selector: "#who", limit: 1 }, tabFirst)).rows[0].text, "signed in", "a tab opened first");
  await registry.finishRun(tabFirst);
  assert.equal(await who(context("r3", ben)), "signed out", "Ben's task does not");
  assert.equal(await who(context("r4")), "signed out", "Branch itself never opens it");

  const adaName = trunkProfileName(ada);
  await assert.rejects(registry.execute("browser.profile", { action: "use", name: adaName }, context("r5", ben)), /another Trunk/);
  await assert.rejects(registry.execute("browser.profile", { action: "use", name: adaName }, context("r6")), /another Trunk/);
  await assert.rejects(registry.execute("browser.profile", { action: "remove", name: adaName }, context("r7", ben)), /another Trunk/);
  const benList = await registry.execute("browser.profile", { action: "list" }, context("r8", ben));
  assert.deepEqual(benList.profiles.map((p) => p.name), [], "nor list it");
  const adaList = await registry.execute("browser.profile", { action: "list" }, context("r9", ada));
  assert.deepEqual(adaList.profiles.map((p) => p.name), [adaName]);
  assert.equal((await browser.profiles.list("test")).length, 1, "the owner's own list (Settings) shows it");
  // A task that uses another saved sign-in never copies it into the Trunk's own.
  await browser.profiles.create("test", "work-mail");
  const shared = context("r10", ben);
  await registry.execute("browser.profile", { action: "use", name: "work-mail" }, shared);
  await assert.rejects(registry.execute("browser.profile", { action: "keep" }, shared), /cannot be kept as this Trunk's own/);
  await registry.finishRun(shared);
  assert.equal((await browser.profiles.list("test")).some((p) => p.name === trunkProfileName(ben)), false);
});

test("a removed Trunk's own browser profile is removed with it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-profile-remove-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.trunks.setMode("trunks", { mode: "on" });
  const ada = app.trunks.create({ name: "Ada" });
  await app.browserProfiles.create(app.runtime.owner, trunkProfileName(ada.id));
  await app.browserProfiles.create(app.runtime.owner, "work-mail");
  app.trunks.remove(ada.id);
  for (let i = 0; i < 100 && (await app.browserProfiles.list(app.runtime.owner)).length > 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await app.browserProfiles.list(app.runtime.owner)).map((p) => p.name), ["work-mail"], "hers is gone; the owner's own is kept");
});

test("site skills: the websites the owner's switched-on skills know, with the skill to forget", async (t) => {
  const document = ["---", "name: the-shop", "description: Knows the quirks of one shop.", "---", "", "# The shop", ""].join("\n");
  const siteFile = JSON.stringify({ site: { hosts: ["shop.example.com"], notes: "Close the cookie notice first." } });
  const loaded = siteSkillsFrom([{ skillId: "id-1", manifest: { name: "the-shop" }, files: { "site.json": siteFile } }], new Set(["id-1"]));
  assert.equal(loaded.list()[0].skillId, "id-1", "each site names the skill it came from");

  const root = await mkdtemp(join(tmpdir(), "branch-site-skills-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { server.close(); await app.close(); await discardTemp(root); });
  const ask = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  assert.deepEqual((await ask("/api/browser/site-skills")).body.sites, []);
  const bytes = packSkill({ files: { "SKILL.md": document, "site.json": siteFile }, author: "Branch", packageVersion: "1.0.0" });
  const installed = await ask("/api/skills/package/install", { file: bytes.toString("base64"), approve: true });
  assert.equal(installed.status, 200);
  const skillId = installed.body.skill.id;
  assert.deepEqual((await ask("/api/browser/site-skills")).body.sites, [], "installed switched off: it brings nothing");
  await ask(`/api/skills/${skillId}/activate`, { expectedRevision: (await ask(`/api/skills/${skillId}`)).body.revision, version: installed.body.skill.headVersion });
  const listed = (await ask("/api/browser/site-skills")).body.sites;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].hosts, ["shop.example.com"]);
  assert.equal(listed[0].notes, "Close the cookie notice first.");
  assert.equal(listed[0].skillId, skillId);
  assert.equal(typeof listed[0].revision, "number");
  const forgot = await ask(`/api/skills/${skillId}/remove`, { expectedRevision: listed[0].revision });
  assert.equal(forgot.status, 200);
  assert.deepEqual((await ask("/api/browser/site-skills")).body.sites, [], "forgotten");
});
