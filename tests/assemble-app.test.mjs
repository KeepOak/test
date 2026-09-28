import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { isJunk } from "junk";
import { discardTemp } from "./temp-dir.mjs";
import { assembleApp, assembleWindowsApp, sanitizePackageJson } from "../scripts/assemble-app.mjs";
import { assemblesWithoutPackager, includedInApp } from "../scripts/package-desktop.mjs";

/**
 * The owner's rule: no executable is ever made on his computer. An unsigned Windows build (every Beta update, built
 * there) lays its app folder out from the stock pieces instead of running the packager, which edits Electron's program.
 * These check that layout on a small made-up project; nothing here is a real program.
 */
async function write(path, text = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function files(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await files(root, path, out);
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out.sort();
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-assemble-"));
  t.after(() => discardTemp(root));
  const source = join(root, "source"), dist = join(root, "electron-dist");
  await write(join(source, "package.json"), JSON.stringify({
    name: "branch-agent", version: "1.2.3", private: true, type: "module",
    scripts: { build: "tsc" }, dependencies: { kept: "1.0.0" }, devDependencies: { tooling: "1.0.0", electron: "44.3.0" },
  }, null, 2));
  await write(join(source, "package-lock.json"), "{}");
  await write(join(source, "LICENSE"));
  await write(join(source, "dist", "cli.js"));
  await write(join(source, "public", "index.html"));
  await write(join(source, "public", ".DS_Store")); // junk: never shipped
  await write(join(source, "src", "cli.ts"));
  await write(join(source, "release", "old", "file"));
  const pkg = (name, deps = {}) => JSON.stringify({ name, version: "1.0.0", dependencies: deps });
  await write(join(source, "node_modules", "kept", "package.json"), pkg("kept", { inner: "1.0.0" }));
  await write(join(source, "node_modules", "kept", "index.js"));
  await write(join(source, "node_modules", "kept", "node_modules", "inner", "package.json"), pkg("inner"));
  await write(join(source, "node_modules", "tooling", "package.json"), pkg("tooling"));
  await write(join(source, "node_modules", "electron", "package.json"), pkg("electron"));
  await write(join(source, "node_modules", ".package-lock.json"), "{}");
  await write(join(dist, "electron.exe"), "stock program bytes");
  await write(join(dist, "ffmpeg.dll"));
  await write(join(dist, "locales", "en-US.pak"));
  await write(join(dist, "resources", "default_app.asar"));
  return { root, source, dist };
}

test("an unsigned Windows build of this computer's own kind never runs the packager; a signed one, or another kind, does", () => {
  assert.equal(assemblesWithoutPackager({}, "x64", "x64"), true);
  assert.equal(assemblesWithoutPackager({ BRANCH_WINDOWS_SIGNING: "true" }, "x64", "x64"), false);
  assert.equal(assemblesWithoutPackager({}, "arm64", "x64"), false);
});

test("the app folder is Electron's own folder less the default app, with the stock program under the app's name", async (t) => {
  const { root, source, dist } = await project(t);
  const into = join(root, "out");
  const runtime = await assembleWindowsApp({ source, dist, into, executableName: "Branch Agent.exe", included: includedInApp, isJunk });
  const runtimeFiles = (await files(into)).filter((name) => !name.startsWith("resources/app/"));
  assert.deepEqual(runtimeFiles, ["Branch Agent.exe", "ffmpeg.dll", "locales/en-US.pak"]);
  assert.equal(await readFile(join(into, "Branch Agent.exe"), "utf8"), "stock program bytes");
  assert.match(runtime.sha256, /^[0-9a-f]{64}$/);
});

test("the app inside keeps only what includedInApp names and the production packages, and no junk", async (t) => {
  const { root, source } = await project(t);
  const into = join(root, "app");
  await assembleApp({ source, into, included: includedInApp, isJunk });
  assert.deepEqual(await files(into), [
    "LICENSE", "dist/cli.js",
    "node_modules/.package-lock.json", "node_modules/kept/index.js", "node_modules/kept/node_modules/inner/package.json", "node_modules/kept/package.json",
    "package-lock.json", "package.json", "public/index.html",
  ]);
});

test("the app's package.json loses its development fields, as the packager writes it", async (t) => {
  const { root, source } = await project(t);
  const into = join(root, "app");
  await assembleApp({ source, into, included: includedInApp, isJunk });
  const text = await readFile(join(into, "package.json"), "utf8");
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(Object.keys(JSON.parse(text)), ["name", "version", "type", "dependencies"]);
  assert.deepEqual(sanitizePackageJson({ name: "a", overrides: {}, husky: {} }), { name: "a" });
});
