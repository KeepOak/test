/**
 * Live updates: each change is placed in the lightest part it reaches (window, engine, gateway, shell), by what really
 * loads each changed file, and every live build is checked file by file before anything loads or serves it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { classify, closure, importsOf, manifestChanged, readCompiled, stylesOnly } from "../dist/hot-update/classify.js";
import { loadWindowFiles, manifestName, sha256, verifyLive, writeManifest } from "../dist/hot-update/manifest.js";

const sources = {
  "src/desktop/main.ts": 'import { a } from "../providers.js";\nimport { b } from "./engine-link.js";\nconst f = new URL("./engine-process.js", import.meta.url);',
  "src/desktop/preload.cts": 'const x = require("./preload-words.cjs");',
  "src/desktop/preload-words.cts": "",
  "src/desktop/engine-link.ts": "",
  "src/desktop/engine-process.ts": 'import { createBranch } from "../index.js";\nimport "./engine-only.js";\nimport { Link } from "./engine-link.js";',
  "src/desktop/engine-only.ts": "",
  "src/providers.ts": "export const a = 1;",
  "src/index.ts": 'export * from "./runtime.js";',
  "src/runtime.ts": "",
  "src/cli.ts": 'const m = await import("./index.js");\nimport { runGatewayIfSwitchedOn } from "./never-break/worker-link.js";',
  "src/never-break/worker-link.ts": 'import { Gateway } from "./gateway.js";',
  "src/never-break/gateway.ts": 'import { x } from "./gateway-state.js";',
  "src/never-break/gateway-state.ts": "",
};
const read = (path) => (Object.hasOwn(sources, path) ? sources[path] : null);
const tier = (changed, manifest) => classify({ changed, read, ...(manifest ? { manifest } : {}) }).tier;

test("imports are read from static imports, re-exports, import() and require()", () => {
  assert.deepEqual(importsOf('import a from "./a.js"; export { b } from "../b.js"; await import("./c.js"); require("./d.cjs"); import "./e.js";').sort(),
    ["../b.js", "./a.js", "./c.js", "./d.cjs", "./e.js"]);
  // A module main starts as a process of its own is not one of main's imports.
  assert.equal(closure(["src/desktop/main.ts"], read).has("src/desktop/engine-process.ts"), false);
  assert.deepEqual([...closure(["src/desktop/preload.cts"], read)].sort(), ["src/desktop/preload-words.cts", "src/desktop/preload.cts"]);
});

test("a change is placed in the part that loads it", () => {
  assert.equal(tier(["public/app/chat/chat.js"]), "window");
  assert.equal(tier(["public/app.css", "docs/x.md"]), "window");
  assert.equal(tier(["src/runtime.ts"]), "engine");
  assert.equal(tier(["data/providers.json"]), "engine");
  assert.equal(tier(["src/desktop/engine-process.ts"]), "engine", "only the engine's own process loads it");
  assert.equal(tier(["src/desktop/engine-only.ts"]), "engine");
  assert.equal(tier(["src/never-break/gateway-state.ts"]), "gateway");
  assert.equal(tier(["src/providers.ts"]), "shell", "main imports it, so main must get it too");
  assert.equal(tier(["src/desktop/engine-link.ts"]), "shell", "shared by main and the engine");
  assert.equal(tier(["src/desktop/preload-words.cts"]), "shell");
  assert.equal(tier(["src/desktop/gone-now.ts"]), "shell", "a removed desktop file is judged by its folder");
  assert.equal(tier(["package-lock.json"]), "shell");
  assert.equal(tier(["public/assets/branch-mascot.png"]), "shell", "main reads the window's icon itself");
  assert.equal(tier(["something/new.bin"]), "shell", "anything unknown is never guessed lighter");
  assert.equal(tier(["tests/a.test.mjs", "README.md", "design/x.html"]), null);
  assert.equal(tier(["public/app/x.js", "src/runtime.ts"]), "engine");
  assert.equal(tier(["public/app/x.js", "src/runtime.ts", "src/providers.ts"]), "shell");
});

test("package.json counts only when what is installed or how Branch starts changed", () => {
  const before = JSON.stringify({ version: "1.0.0", dependencies: { zod: "4" } });
  assert.equal(manifestChanged(before, JSON.stringify({ version: "1.0.1", dependencies: { zod: "4" } })), false);
  assert.equal(manifestChanged(before, JSON.stringify({ version: "1.0.0", dependencies: { zod: "5" } })), true);
  assert.equal(manifestChanged(before, "not json"), true);
  assert.equal(tier(["package.json"], { before, after: JSON.stringify({ version: "1.0.1", dependencies: { zod: "4" } }) }), null);
  assert.equal(tier(["package.json"], { before, after: JSON.stringify({ version: "1.0.0", devDependencies: { electron: "45" } }) }), "shell");
  assert.equal(tier(["package.json"]), "shell", "without both sides it is never guessed lighter");
});

test("only stylesheets: swapped in place", () => {
  assert.equal(stylesOnly(["public/app.css"]), true);
  assert.equal(stylesOnly(["public/app.css", "public/app/main.js"]), false);
  assert.equal(stylesOnly([]), false);
});

test("the real build: main's own imports (the retained gateway too) are shell, the runtime is engine", async () => {
  const real = await readCompiled(process.cwd());
  const at = (path) => real.get(path) ?? null;
  const place = (path) => classify({ changed: [path], read: at }).tier;
  assert.equal(place("src/desktop/main.ts"), "shell");
  assert.equal(place("src/runtime.ts"), "engine");
  // PLAT-026: the retained broker runs the gateway inside main's own process (src/desktop/gateway-runtime.ts); its Gateway
  // methods are replaced in place from the checked build (src/desktop/gateway-code.ts). Without a retained gateway the
  // change still goes the packaged way (hot-apply.ts residentGatewayOutcome).
  assert.equal(place("src/never-break/gateway.ts"), "gateway");
  assert.equal(place("src/desktop/engine-process.ts"), "engine");
  assert.equal(place("public/app/chat/chat.js"), "window");
});

async function liveFolder() {
  const root = await mkdtemp(join(tmpdir(), "branch-live-"));
  await mkdir(join(root, "dist", "desktop"), { recursive: true });
  await mkdir(join(root, "public", "app"), { recursive: true });
  await writeFile(join(root, "dist", "desktop", "engine-process.js"), "export {};\n");
  await writeFile(join(root, "public", "app.css"), "body{}\n");
  await writeFile(join(root, "public", "app", "main.js"), "export {};\n");
  return root;
}
const COMMIT = "a".repeat(40);

test("a live build is used only exactly as it was built", async (t) => {
  const root = await liveFolder();
  t.after(() => discardTemp(root));
  const { manifest, digest } = await writeManifest(root, COMMIT, "0.19.4-dev.1-gaaaaaaaaaaaa");
  assert.deepEqual(Object.keys(manifest.files).sort(), ["dist/desktop/engine-process.js", "public/app.css", "public/app/main.js"]);
  assert.equal((await verifyLive(root, { commit: COMMIT, digest })).commit, COMMIT);
  const window = await loadWindowFiles(root, manifest);
  assert.equal(window.get("app.css").toString(), "body{}\n");
  assert.equal(window.has("desktop/engine-process.js"), false, "the window is served the window's files only");

  // Another change's build, or a record changed after the build, is refused.
  await assert.rejects(verifyLive(root, { commit: "b".repeat(40), digest }), /hash|another change/);
  await assert.rejects(verifyLive(root, { commit: COMMIT, digest: sha256("x") }), /changed after it was built/);

  // A changed file, a new file and a missing file are each refused.
  await writeFile(join(root, "public", "app.css"), "body{color:red}\n");
  await assert.rejects(verifyLive(root, { commit: COMMIT, digest }), /public\/app\.css is not the file that was built/);
  await assert.rejects(loadWindowFiles(root, manifest), /not the file that was built/);
  await writeFile(join(root, "public", "app.css"), "body{}\n");
  await writeFile(join(root, "dist", "extra.js"), "evil();\n");
  await assert.rejects(verifyLive(root, { commit: COMMIT, digest }), /does not list/);
});

test("a live build holding a link is refused", async (t) => {
  const root = await liveFolder();
  t.after(() => discardTemp(root));
  const { digest } = await writeManifest(root, COMMIT, "1.0.0");
  const made = await symlink(join(root, "public", "app.css"), join(root, "public", "linked.css"), "file").then(() => true, () => false);
  if (!made) return t.skip("this computer does not let a test make a link");
  await assert.rejects(verifyLive(root, { commit: COMMIT, digest }), /link/);
});

test("the record itself is whole JSON of the exact shape", async (t) => {
  const root = await liveFolder();
  t.after(() => discardTemp(root));
  const { digest } = await writeManifest(root, COMMIT, "1.0.0");
  const text = await readFile(join(root, manifestName), "utf8");
  assert.equal(sha256(text), digest);
  const bent = JSON.parse(text);
  bent.files["../outside.js"] = { sha256: "0".repeat(64), size: 0 };
  const bentText = `${JSON.stringify(bent)}\n`;
  await writeFile(join(root, manifestName), bentText);
  await assert.rejects(verifyLive(root, { commit: COMMIT, digest: sha256(bentText) }), /Invalid|invalid|regex|pattern/i);
});
