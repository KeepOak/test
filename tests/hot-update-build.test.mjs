/**
 * Live updates, the build: a Beta change is fetched and checked exactly as a packaged Beta build is (only the exact
 * change, only on Beta's line, only forward), then placed: a change to the window's files is copied with nothing
 * compiled, a change to the engine is compiled and never packaged, and a change the app's main process loads goes the
 * packaged way. Real git on a repository made here; the programs the build runs are the repository's own tiny scripts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { buildLive } from "../dist/hot-update/live-build.js";
import { betaLine } from "../dist/desktop/dev-build.js";
import { verifyLive } from "../dist/hot-update/manifest.js";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd }).then((out) => out.stdout.trim());
const REPO = "branch-test/live";
const lf = (text) => text.replaceAll("\r\n", "\n");
const exists = (path) => access(path).then(() => true, () => false);

/** A tiny Branch: main imports a shared file, the engine imports the runtime, the window has a page and a stylesheet. */
const files = {
  "package.json": JSON.stringify({ name: "branch-agent", version: "1.2.3", scripts: { build: "node scripts/build-ts.mjs" }, dependencies: { zod: "4" } }, null, 2),
  "package-lock.json": JSON.stringify({ name: "branch-agent", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "branch-agent", version: "1.2.3" } } }, null, 2),
  "scripts/build-ts.mjs": `import { cp, readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
const walk = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((e) => e.isDirectory() ? [] : [join(dir, e.name)]);
async function all(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await all(p)); else out.push(p); } return out; }
for (const file of await all("src")) { const to = file.replace(/^src/, "dist").replace(/\\.ts$/, ".js"); await mkdir(dirname(to), { recursive: true }); await writeFile(to, await readFile(file)); }
await writeFile("built.txt", String(Date.now()));
`,
  "scripts/copy-fonts.mjs": "export {};\n",
  "src/desktop/main.ts": 'import { shared } from "../shared.js";\n',
  "src/desktop/engine-process.ts": 'import { run } from "../runtime.js";\n',
  "src/cli.ts": 'import { run } from "./runtime.js";\n',
  "src/never-break/worker-link.ts": 'import { Gateway } from "./gateway.js";\n',
  "src/never-break/gateway.ts": "export const Gateway = 1;\n",
  "src/shared.ts": "export const shared = 1;\n",
  "src/runtime.ts": "export const run = 1;\n",
  "public/index.html": "<!doctype html>\n",
  "public/app.css": "body{}\n",
  "public/app/main.js": "export {};\n",
};

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-build-"));
  t.after(() => discardTemp(root));
  const work = join(root, "work"), origin = join(root, "origin.git");
  await mkdir(work, { recursive: true });
  await git(work, "init", "--quiet", "-b", betaLine);
  for (const [name, body] of Object.entries(files)) { await mkdir(join(work, name, ".."), { recursive: true }); await writeFile(join(work, name), body); }
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", "first");
  await exec("git", ["init", "--quiet", "--bare", origin]);
  await git(work, "push", "--quiet", origin, `HEAD:refs/heads/${betaLine}`);
  const change = async (edits, message = "change") => {
    for (const [name, body] of Object.entries(edits)) { await mkdir(join(work, name, ".."), { recursive: true }); await writeFile(join(work, name), body); }
    await git(work, "add", "-A");
    await git(work, "commit", "--quiet", "-m", message);
    await git(work, "push", "--quiet", "--force", origin, `HEAD:refs/heads/${betaLine}`);
    return git(work, "rev-parse", "HEAD");
  };
  const first = await git(work, "rev-parse", "HEAD");
  return { root, work, origin, first, change };
}

/**
 * The build's programs, run for real, except that GitHub is this test's own repository (git fetches it by path, so the
 * https-only walls are lifted here only) and npm's two commands run the repository's scripts directly.
 */
function runner(origin, seen) {
  return async (file, args, options) => {
    seen.push([file, ...args].join(" "));
    if (file === "npm" && args[0] === "--version") return "10.0.0\n";
    if (file === "npm" && args[0] === "ci") { await mkdir(join(options.cwd, "node_modules", "zod"), { recursive: true }); await writeFile(join(options.cwd, "node_modules", "zod", "package.json"), "{}"); return ""; }
    if (file === "npm" && args[0] === "run") return (await exec(process.execPath, [`scripts/${args[1] === "build" ? "build-ts" : args[1]}.mjs`], { cwd: options.cwd })).stdout;
    const cleaned = args.filter((arg, index) => !(arg === "protocol.allow=never" || (arg === "-c" && args[index + 1] === "protocol.allow=never")))
      .map((arg) => arg === `https://github.com/${REPO}.git` ? origin : arg);
    const env = { ...process.env, ...(options.env ?? {}), GIT_ALLOW_PROTOCOL: "file" };
    return (await exec(file, cleaned, { cwd: options.cwd, env, timeout: options.timeoutMs, maxBuffer: 64 << 20 })).stdout;
  };
}

async function plan(t, repo, commit, overrides = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "branch-live-app-"));
  t.after(() => discardTemp(appRoot));
  const seen = [];
  const stages = [];
  const run = runner(repo.origin, seen);
  const outcome = await buildLive(run, { repo: REPO, buildDir: join(repo.root, "build"), commit, running: repo.first, packaged: repo.first,
    engineAt: repo.first, windowAt: repo.first, appRoot, onStage: (stage, state) => stages.push(`${stage}:${state}`), ...overrides });
  return { outcome, seen, stages, appRoot };
}

test("a change to the window's files alone is copied, checked and recorded, with nothing compiled", { timeout: 120000 }, async (t) => {
  const repo = await repository(t);
  const commit = await repo.change({ "public/app.css": "body{color:green}\n", "docs/notes.md": "words\n" });
  const { outcome, seen } = await plan(t, repo, commit);
  assert.equal(outcome.tier, "window");
  assert.ok(!seen.some((line) => /npm run build/.test(line)), "not compiled");
  assert.deepEqual((await readdir(outcome.dir)).sort(), ["live-manifest.json", "public"], "the window's files only");
  assert.equal(lf(await readFile(join(outcome.dir, "public", "app.css"), "utf8")), "body{color:green}\n");
  await verifyLive(outcome.dir, { commit, digest: outcome.digest });
  assert.match(outcome.version, new RegExp(`^1\\.2\\.4-dev\\.\\d+-g${commit.slice(0, 12)}$`));
});

test("a change to the engine is compiled, never packaged, and holds the engine's own build", { timeout: 120000 }, async (t) => {
  const repo = await repository(t);
  const commit = await repo.change({ "src/runtime.ts": "export const run = 2;\n" });
  const { outcome, seen } = await plan(t, repo, commit);
  assert.equal(outcome.tier, "engine");
  assert.ok(seen.some((line) => line === "npm run build"), "compiled");
  assert.ok(!seen.some((line) => /package-desktop|dependency-notices/.test(line)), "never packaged");
  assert.equal(lf(await readFile(join(outcome.dir, "dist", "runtime.js"), "utf8")), "export const run = 2;\n");
  assert.equal(JSON.parse(await readFile(join(outcome.dir, "dist", "build-info.json"), "utf8")).commit, commit);
  assert.ok(JSON.parse(await readFile(join(outcome.dir, "dist", "build-info.json"), "utf8")).ancestors.includes(repo.first));
  assert.equal(JSON.parse(await readFile(join(outcome.dir, "package.json"), "utf8")).version, outcome.version, "it answers to its own version");
  await verifyLive(outcome.dir, { commit, digest: outcome.digest });
});

test("a change the app's main process loads, or new packages, goes the packaged way", { timeout: 120000 }, async (t) => {
  const repo = await repository(t);
  const shared = await repo.change({ "src/shared.ts": "export const shared = 2;\n" });
  const first = await plan(t, repo, shared);
  assert.equal(first.outcome.tier, "shell");
  assert.match(first.outcome.reason, /src\/shared\.ts is loaded by the app's main process/);
  assert.equal(await exists(join(first.appRoot, "live")), false, "nothing was staged");
  const packages = await repo.change({ "package.json": JSON.stringify({ name: "branch-agent", version: "1.2.3", scripts: { build: "node scripts/build-ts.mjs" }, dependencies: { zod: "5" } }, null, 2) });
  assert.equal((await plan(t, repo, packages)).outcome.tier, "shell");
});

test("the gateway's own code is its own part; a change touching nothing that runs needs nothing", { timeout: 120000 }, async (t) => {
  const repo = await repository(t);
  const gateway = await repo.change({ "src/never-break/gateway.ts": "export const Gateway = 2;\n" });
  assert.equal((await plan(t, repo, gateway)).outcome.tier, "gateway");
  const docs = await repo.change({ "docs/more.md": "more\n" });
  assert.equal((await plan(t, repo, docs, { packaged: gateway, engineAt: gateway, windowAt: gateway, running: gateway })).outcome.tier, "none");
});

test("only the exact change on Beta's line, and only forward, is ever built", { timeout: 120000 }, async (t) => {
  const repo = await repository(t);
  const onLine = await repo.change({ "src/runtime.ts": "export const run = 3;\n" });
  // A change pushed somewhere else is not on the line.
  await git(repo.work, "checkout", "--quiet", "-b", "elsewhere");
  await writeFile(join(repo.work, "src", "runtime.ts"), "export const run = 666;\n");
  await git(repo.work, "commit", "--quiet", "-am", "off the line");
  await git(repo.work, "push", "--quiet", repo.origin, "HEAD:refs/heads/elsewhere");
  const off = await git(repo.work, "rev-parse", "HEAD");
  await assert.rejects(plan(t, repo, off), /is not on Beta's line of work/);
  // Going back: the running change is newer than the one asked for.
  await assert.rejects(plan(t, repo, repo.first, { running: onLine, packaged: onLine, engineAt: onLine, windowAt: onLine }), /would go back/);
});
