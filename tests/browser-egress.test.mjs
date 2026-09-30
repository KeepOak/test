import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget, RunArtifacts } from "../dist/index.js";

void chromium; // the browser group: this file starts a real Chromium through BranchBrowser.
const secret = "wk-live-8f2c4d6e0a1b9c7d";

/**
 * A page the browser is sent to (a form sent by address, a link, a redirect) whose address would carry a locker value
 * out is not opened; the address the task itself asked for was already judged as that tool call.
 */
test("a form that would send a locker value out in the next page's address is not opened", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Search</title><form action="/search" method="get">
<label>Query <input name="q"></label><button>Go</button></form>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), "branch-egress-browser-"));
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.artifacts = new RunArtifacts(join(root, "artifacts"));
  browser.egressSecrets = () => [secret];
  t.after(async () => { await browser.close(); await discardTemp(root); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "egress-form", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0 };
  const run = (name, input = {}) => registry.execute(name, input, context);
  await run("browser.navigate", { url: `${origin}/` });
  await run("browser.fill", { label: "Query", value: `weather ${secret.slice(2, 14)}` });
  await run("browser.click", { role: "button", name: "Go" }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!seen.some((path) => path.startsWith("/search")), `the page was not requested: ${JSON.stringify(seen)}`);
  // Control: an ordinary search goes through.
  await run("browser.navigate", { url: `${origin}/` });
  await run("browser.fill", { label: "Query", value: "weather in Lagos" });
  await run("browser.click", { role: "button", name: "Go" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(seen.some((path) => path.startsWith("/search?q=weather+in+Lagos")), JSON.stringify(seen));
});
