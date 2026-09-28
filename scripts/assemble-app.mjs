/**
 * The Windows app folder, put together without @electron/packager.
 *
 * The owner's rule: no executable is ever made on his computer. Every Beta update used to run the packager there, and
 * the packager writes a brand-new executable (Electron's own, with Branch's name, icon and version edited into it)
 * before scripts/package-desktop.mjs copied the stock one back over it. An unsigned build ships the stock executable
 * anyway, so it is now never edited: this file lays out exactly what the packager left, from the pieces it used.
 *
 * - The runtime: Electron's own folder (node_modules/electron/dist) as it is, less the default app, with the stock
 *   `electron.exe` under the program's name. Its bytes are checked equal to the stock file after copying.
 * - The app (resources/app): the files `includedInApp` names, the production packages only (the packager's own
 *   pruning library, galactus, asked the same question the packager asks it), no junk files, links followed, and
 *   package.json without its development fields, as the packager writes it.
 *
 * Nothing here runs a program. Signed releases, macOS and Linux still use the packager (package-desktop.mjs).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The package.json fields the packager (20.x, sanitize-package-json.js) strips from the copy inside the app. */
export const sanitizedFields = ["devDependencies", "scripts", "workspaces", "packageManager", "resolutions", "overrides", "pnpm",
  "private", "publishConfig", "devEngines", "jest", "eslintConfig", "prettier", "browserslist", "lint-staged", "nano-staged",
  "husky", "commitlint", "mocha", "ava", "nyc", "c8", "tap", "xo", "standard"];

/** What the packager leaves out of Electron's own folder: the default app. */
export const runtimeDropped = new Set(["resources/default_app.asar", "resources/default_app"]);

export function sanitizePackageJson(manifest) {
  const out = { ...manifest };
  for (const field of sanitizedFields) delete out[field];
  return out;
}

/** A path inside the app, as the packager's filters see it: forward slashes, starting with `/` ("" for the root). */
export const appPath = (root, file) => {
  const rel = relative(root, file).split(sep).join("/");
  return rel ? `/${rel}` : "";
};

/**
 * The production packages, as `/node_modules/...` paths: galactus walks package.json's dependencies (never the
 * development ones, never Electron itself), exactly as @electron/packager's Pruner does.
 */
export async function productionModules(root) {
  const { DestroyerOfModules, DepType } = await import("galactus");
  const walker = new DestroyerOfModules({
    rootDirectory: root,
    shouldKeepModuleTest: (module, isDevDep) => !isDevDep && module.depType !== DepType.ROOT && !["electron", "electron-nightly"].includes(module.name),
  });
  const kept = await walker.collectKeptModules({ relativePaths: true });
  return new Set([...kept.keys()].map((path) => `/${path.split(sep).join("/")}`));
}

/** Whether `name` (an app path) is a package folder: a package.json inside, directly under node_modules (or a scope). */
async function isModuleFolder(root, name) {
  const parts = name.split("/");
  const parent = parts.at(-2), grand = parts.at(-3);
  const underModules = parent === "node_modules" || (parent?.startsWith("@") && grand === "node_modules");
  return underModules && (await stat(join(root, ...parts, "package.json")).then(() => true, () => false));
}

/**
 * Copies the app (resources/app) from `source` (a built checkout) into `into`. `included`: package-desktop.mjs's
 * includedInApp. `isJunk`: the junk package's test, handed in so this file needs nothing the tests do not have.
 */
export async function assembleApp({ source, into, included, isJunk, modules }) {
  const kept = modules ?? await productionModules(source);
  const filter = async (file) => {
    const name = appPath(source, file);
    if (name && isJunk(file.split(sep).at(-1) ?? "")) return false;
    if (name.startsWith("/node_modules/") && await isModuleFolder(source, name)) return kept.has(name);
    return included(name);
  };
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  for (const entry of await readdir(source)) {
    const from = join(source, entry);
    if (await filter(from)) await cp(from, join(into, entry), { recursive: true, dereference: true, filter });
  }
  const manifestPath = join(into, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(sanitizePackageJson(manifest), null, 2)}\n`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, path, out);
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

/**
 * Copies Electron's own folder (`dist`, holding `electron.exe`) into `into`, less the default app, with the stock
 * program under `executableName`. The program's bytes must come out equal to the stock file's, or nothing is kept.
 */
export async function assembleRuntime({ dist, into, executableName }) {
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  for (const name of await listFiles(dist)) {
    if (runtimeDropped.has(name) || [...runtimeDropped].some((dropped) => name.startsWith(`${dropped}/`))) continue;
    const target = join(into, ...(name === "electron.exe" ? [executableName] : name.split("/")));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(dist, ...name.split("/")), target);
  }
  const program = join(into, executableName);
  const [stock, copied] = await Promise.all([sha256(join(dist, "electron.exe")), sha256(program)]);
  if (stock !== copied) {
    await rm(into, { recursive: true, force: true });
    throw new Error("The copied program is not byte for byte Electron's own, so no app folder was made.");
  }
  await utimes(program, new Date(), new Date()); // Electron's file dates predate 1980, which ZIP cannot store
  return { executable: program, sha256: stock };
}

/** The whole Windows app folder: the runtime, then the app in resources/app. */
export async function assembleWindowsApp({ source, dist, into, executableName, included, isJunk }) {
  const runtime = await assembleRuntime({ dist, into, executableName });
  await assembleApp({ source, into: join(into, "resources", "app"), included, isJunk });
  return runtime;
}

/**
 * `node scripts/assemble-app.mjs --app <folder>` (or `--runtime <folder> --name <program>`): the app alone (resources/app) of this built checkout, as the Beta
 * update puts a new version's folder together beside the running one (src/desktop/dev-build.ts): the mascot icon the
 * shortcuts name first, then the app, pruned as above. The runtime is the updater's to lay out (a link to the one in use).
 */
async function main(argv) {
  const value = (flag) => { const at = argv.indexOf(flag), found = at >= 0 ? argv[at + 1] : undefined; return found && !found.startsWith("--") ? found : undefined; };
  // `--runtime <folder> --name <program>`: Electron's own stock folder, when a new version brings another Electron.
  const runtime = value("--runtime");
  if (runtime) {
    const name = value("--name");
    if (!name) throw new Error("--runtime needs --name <program>");
    // Asking for Electron's program fetches it into node_modules the first time, as packaging always has.
    const dist = dirname((await import("electron")).default);
    const made = await assembleRuntime({ dist, into: runtime, executableName: name });
    console.log(`${made.executable} sha256 ${made.sha256}`);
    return;
  }
  const into = value("--app");
  if (!into) throw new Error("usage: node scripts/assemble-app.mjs --app <folder> | --runtime <folder> --name <program>");
  const { includedInApp } = await import("./package-desktop.mjs");
  const { isJunk } = await import("junk");
  if (process.platform === "win32") await (await import("./make-icons.mjs")).writeWindowsIcon();
  await assembleApp({ source: ".", into, included: includedInApp, isJunk });
  console.log(into);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exit(1); });
