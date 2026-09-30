// Refresh tests/shard-weights.json from a Checks run's measured timings.
//
//   node scripts/test-weights.mjs <run-id> [--repo owner/name]
//
// Each share of a Checks run uploads how long each of its files took (`test-timings-<lane>-<share>`). This downloads
// them, puts each lane's seconds under that system's key (linux, win32, darwin), keeps what the run did not measure,
// and drops files that no longer exist. scripts/run-tests.mjs packs the shares from these weights, and
// scripts/select-affected-tests.mjs sizes a pull request's partial run from the Linux ones.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANES } from "./run-tests.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const weightsFile = join(root, "tests", "shard-weights.json");

/** Merge measured timings (`{ lane: [{ file: seconds }] }`) into the weights, dropping files that are gone. */
export function mergeWeights(weights, measured, exists = (file) => existsSync(join(root, file))) {
  const merged = {};
  for (const platform of new Set([...Object.keys(weights), ...Object.values(LANES)])) {
    const lane = Object.keys(LANES).find((name) => LANES[name] === platform);
    const next = { ...weights[platform] };
    for (const part of measured[lane] ?? []) Object.assign(next, part);
    merged[platform] = Object.fromEntries(Object.entries(next).filter(([file]) => exists(file)).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return merged;
}

/** Every `test-timings-<lane>-<share>/test-timings.json` in a folder, by lane. */
export function readTimings(folder) {
  const measured = {};
  for (const name of readdirSync(folder)) {
    const match = /^test-timings-([a-z]+)-\d+$/.exec(name);
    const file = join(folder, name, "test-timings.json");
    if (!match || !(match[1] in LANES) || !existsSync(file)) continue;
    (measured[match[1]] ??= []).push(JSON.parse(readFileSync(file, "utf8")));
  }
  return measured;
}

function main() {
  const [run, ...rest] = process.argv.slice(2);
  if (!/^\d+$/.test(run ?? "")) throw new Error("Usage: node scripts/test-weights.mjs <run-id> [--repo owner/name]");
  const repo = rest[0] === "--repo" ? ["--repo", rest[1]] : [];
  const folder = mkdtempSync(join(tmpdir(), "branch-weights-"));
  try {
    execFileSync("gh", ["run", "download", run, ...repo, "--pattern", "test-timings-*", "--dir", folder], { stdio: "inherit" });
    const measured = readTimings(folder);
    const weights = mergeWeights(existsSync(weightsFile) ? JSON.parse(readFileSync(weightsFile, "utf8")) : {}, measured);
    writeFileSync(weightsFile, `${JSON.stringify(weights, null, 1)}\n`);
    for (const [lane, parts] of Object.entries(measured)) console.log(`${lane}: ${parts.reduce((n, part) => n + Object.keys(part).length, 0)} files measured`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
