/* Idle memory: what the app's processes load before anyone uses a feature (the owner's QA, 2026-09-27: Branch idle
   sat at about 750-920 MB against Hermes' 120 MB).
   The window's main process drew in the whole engine (about 1,170 modules, over 70 MB of its heap) through the Beta
   try-out, the update record and the export code, although the engine runs in a process of its own; the engine held
   Playwright's code from the start although a browser is opened only on demand; and every comment was shipped, which
   V8 keeps in memory with each module's source, twice over for a file with one character past Latin-1.
   These read the built files only: nothing starts, nothing waits.
   Mutation: import `smokeMode` statically again in src/desktop/main.ts (the main process reaches src/index.ts), or
   `chromium` from 'playwright' in src/integrations/browser.ts (the engine reaches Playwright), and a case fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const staticImport = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/g;

/** Every file and package a built module loads before it runs: its static imports, followed through dist/. */
function staticClosure(entry) {
  const seen = new Set(), stack = [resolve(dist, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith("package:")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(staticImport)) {
      const spec = match[1] ?? match[2];
      if (!spec.startsWith(".")) { stack.push(`package:${spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")}`); continue; }
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) stack.push(target);
    }
  }
  return [...seen].map((file) => (file.startsWith("package:") ? file : relative(dist, file).replace(/\\/g, "/")));
}

test("the window's main process loads the window's own code, not the engine's", () => {
  const loaded = staticClosure("desktop/main.js");
  for (const engine of ["index.js", "server.js", "store.js", "desktop/beta-smoke-window.js", "desktop/conversation-export.js", "install/headless-update.js", "package:playwright"])
    assert.equal(loaded.includes(engine), false, `main loads ${engine} only when it is needed`);
  assert.ok(loaded.length < 250, `main's own code stays small: ${loaded.length} modules at start`);
});

test("the engine loads Playwright only when a browser is started or joined", () => {
  const loaded = staticClosure("desktop/engine-process.js");
  assert.ok(loaded.includes("index.js"), "the engine is what loads the assistant");
  assert.equal(loaded.includes("package:playwright"), false, "Playwright is not loaded with the engine");
  assert.equal(loaded.includes("package:playwright-core"), false);
});

test("the engine loads the MCP SDK only when a server is connected, listed or called", () => {
  // About 5 MB of heap (its client, transports and schemas): src/integrations/mcp-sdk.ts loads it on use.
  const loaded = staticClosure("desktop/engine-process.js");
  assert.equal(loaded.includes("package:@modelcontextprotocol/sdk"), false, "the MCP SDK is not loaded with the engine");
  assert.equal(loaded.includes("examples/mcp-notes-server.js"), false, "the example server is its own program");
});

test("a window started in the tray does not draw until it is first shown", () => {
  // Electron counts a window that was never shown as visible (paintWhenInitiallyHidden), so a tray start drew, decoded
  // its loops and held its tiles for nobody: 390 MB instead of 774 MB working set when it does not.
  const main = readFileSync(resolve(dist, "desktop/main.js"), "utf8");
  assert.match(main, /paintWhenInitiallyHidden: !startsMinimized\(process\.argv\)/);
});

test("comments are not shipped in the built code, where V8 would keep them with each module's source", () => {
  const { compilerOptions } = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
  assert.equal(compilerOptions.removeComments, true);
  const main = readFileSync(resolve(dist, "desktop/main.js"), "utf8");
  assert.equal(/^\s*\/\/ /m.test(main), false, "the built main process has no line comments");
});

test("the added chat services load when one is built, listed or switched, and their kinds are known without them", async () => {
  // About 2.6 MB of heap for 36 services: src/channels/parity-services.ts is loaded on use by parity-config.ts.
  const loaded = staticClosure("desktop/engine-process.js");
  assert.equal(loaded.includes("channels/parity-services.js"), false, "the service list is not loaded with the engine");
  for (const service of ["irc", "xmpp", "nostr", "wechat", "mumble"]) assert.equal(loaded.includes(`channels/${service}.js`), false, `${service} is not loaded with the engine`);
  const { parityServices } = await import("../dist/channels/parity-services.js");
  const { PARITY_KINDS } = await import("../dist/channels/parity-kinds.js");
  assert.deepEqual([...PARITY_KINDS], parityServices.map((service) => service.kind), "the static kinds are the services' own, in order");
});

test("the built code holds no character past Latin-1, so V8 keeps every module's source at one byte a character", () => {
  // scripts/ascii-dist.mjs writes them as \u escapes; one such character would double that file's source in memory.
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.c?js$/.test(entry.name) && /[^\u0000-ÿ]/.test(readFileSync(path, "utf8"))) found.push(relative(dist, path));
    }
  };
  walk(dist);
  assert.deepEqual(found, [], "built files with a wide character");
});

test("the engine builds its personal part on first use, listing its tools from their cards until then", () => {
  // PLAT-191 (src/tool-cards.ts): the part's code, its connectors and their clients load when first needed.
  const loaded = staticClosure("desktop/engine-process.js");
  assert.equal(loaded.includes("personal/index.js"), false, "the personal part is not loaded with the engine");
  for (const connector of ["personal/google.js", "personal/microsoft.js", "personal/mail-search.js", "personal/tunnel.js"])
    assert.equal(loaded.includes(connector), false, `${connector} is not loaded with the engine`);
});
