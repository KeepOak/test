// `npm run build`'s compile step: tsc with --incremental, so a build after a small change re-checks and re-emits only
// what that change reaches (about 10 s instead of about a minute). The build info lives in .build-cache/ (gitignored),
// outside node_modules/ (npm ci wipes it) and outside dist/ (which is shipped). A plain `tsc` stays a full build.
//
// tsc trusts its build info blindly: it does not look at dist/. So the build info is thrown away, and the build is a
// full one, when dist/ no longer matches it: an output is missing (dist/ cleaned, a file deleted), or an output is
// newer than the build info (something else, e.g. a plain `tsc` on another checkout, wrote dist/ since).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pruneDist } from "./prune-dist.mjs";

const info = resolve(".build-cache/tsc.tsbuildinfo");
const src = resolve("src");
const dist = resolve("dist");

/** The files tsc writes for one source: the program, its source map and its declarations. */
function outputs(file) {
  const rel = relative(src, file);
  const [base, js, dts] = rel.endsWith(".cts") ? [rel.slice(0, -4), ".cjs", ".d.cts"] : [rel.slice(0, -3), ".js", ".d.ts"];
  return [`${base}${js}`, `${base}${js}.map`, `${base}${dts}`].map((name) => join(dist, name));
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.c?ts$/.test(entry.name) && !/\.d\.c?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Why the build info cannot be trusted, or null when dist/ is exactly what it says it built. */
function stale() {
  let kept, built;
  try { kept = statSync(info).mtimeMs; } catch { return null; }
  // Only sources tsc has already built are held to it: one a pull request adds has no output yet, and tsc emits it.
  try { built = new Set(JSON.parse(readFileSync(info, "utf8")).fileNames.map((name) => resolve(dirname(info), name))); }
  catch { return "its build info cannot be read"; }
  for (const file of sources(src).filter((one) => built.has(one))) {
    for (const output of outputs(file)) {
      let written;
      try { written = statSync(output).mtimeMs; } catch { return `${relative(".", output)} is missing`; }
      if (written > kept) return `${relative(".", output)} was written after the last incremental build`;
    }
  }
  return null;
}

// Outputs of sources that are gone (deleted or renamed since dist/ was built, here or in the CI build cache).
const orphans = pruneDist(dist, src);
if (orphans.length) console.log(`build-ts: removed ${orphans.length} built file(s) whose source is gone, e.g. ${orphans[0]}`);
const reason = stale();
if (reason) {
  console.log(`build-ts: full build (${reason})`);
  rmSync(info, { force: true });
}
mkdirSync(resolve(".build-cache"), { recursive: true });
const tsc = resolve("node_modules/typescript/bin/tsc");
const run = spawnSync(process.execPath, [tsc, "--incremental", "--tsBuildInfoFile", info], { stdio: "inherit" });
process.exit(run.status ?? 1);
