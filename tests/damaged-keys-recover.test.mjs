/**
 * QA retest 2026-09-28 (TRUNK-180, corrupted state): the saved session token or the question key file, damaged (empty
 * here), stopped every start: "Invalid saved session token" or "The question key file is damaged; move it aside to
 * start a new one", and under the gateway the engine was restarted until the gateway gave up. Each is now put aside and
 * a new one made, so Branch starts and the saved work is still there. Damaged saved work (branch.sqlite) still stops the
 * start, and no longer promises safety copies that were never made. Node only: the real dist/, `branch start` with no
 * model, port 0, temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBranch } from "../dist/index.js";
import { dataProblemSentence } from "../dist/never-break/migrations.js";
import { discardTemp } from "./temp-dir.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Starts `branch start` on a data folder; resolves with its words once it listens, or once it has ended, and a stop. */
function start(dataDir, workspace) {
  const child = spawn(process.execPath, [cli, "start"], { env: { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace, BRANCH_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  const ended = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => { if (child.exitCode === null) child.kill(); await ended; };
  return new Promise((resolve) => {
    const seen = (chunk) => { out += chunk; if (/Local session token/.test(out)) resolve({ up: true, out, stop }); };
    child.stdout.on("data", seen); child.stderr.on("data", seen);
    void ended.then(() => resolve({ up: false, out, stop }));
  });
}

async function seeded(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-damaged-keys-"));
  t.after(() => discardTemp(root));
  const dataDir = join(root, "data"), workspace = join(root, "w");
  await mkdir(dataDir, { recursive: true });
  const app = await createBranch({ workspace, dataDir });
  app.store.save("settings", app.runtime.owner, "t180", { kept: "yes" });
  await app.close();
  return { dataDir, workspace, kept: async () => {
    const again = await createBranch({ workspace, dataDir });
    try { return again.store.get("settings", again.runtime.owner, "t180")?.data.kept; } finally { await again.close(); }
  } };
}

for (const [file, fresh] of [["session-token", /^[a-f0-9]{64}$/], ["question-fingerprint.key", null]]) {
  test(`a damaged ${file} is put aside and a new one made, and Branch starts`, async (t) => {
    const { dataDir, workspace, kept } = await seeded(t);
    await writeFile(join(dataDir, file), "");
    const started = await start(dataDir, workspace);
    await started.stop(); // stopped before the checks, so the temporary folder can go afterwards
    assert.ok(started.up, started.out);
    assert.match(started.out, new RegExp(`put aside as .*${file.replace(".", "\\.")}\\.unreadable-`));
    const now = await readFile(join(dataDir, file));
    if (fresh) assert.match(now.toString("utf8"), fresh); else assert.equal(now.length, 32);
    assert.ok((await readdir(dataDir)).some((name) => name.startsWith(`${file}.unreadable-`)), "the damaged one is kept aside");
    assert.equal(await kept(), "yes", "the saved work is still there");
  });
}

test("the saved work is untouched by a new key or token", async (t) => {
  const { dataDir, kept } = await seeded(t);
  await writeFile(join(dataDir, "session-token"), "");
  await writeFile(join(dataDir, "question-fingerprint.key"), "x");
  const { useFingerprintKey } = await import("../dist/question-fingerprint.js");
  await useFingerprintKey(dataDir);
  assert.equal(await kept(), "yes");
});

test("damaged saved work says whether a safety copy exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-damaged-db-"));
  t.after(() => discardTemp(root));
  const broken = Object.assign(new Error("file is not a database"), { errcode: 26 });
  const path = join(root, "branch.sqlite");
  assert.match(dataProblemSentence(path, broken), /made no safety copy of it yet[\s\S]*move this file somewhere else/);
  assert.doesNotMatch(dataProblemSentence(path, broken), /update-backups/);
  await mkdir(join(root, "update-backups"));
  await writeFile(join(root, "update-backups", "before-format-1.sqlite"), "copy");
  assert.match(dataProblemSentence(path, broken), /safety copies are in the `update-backups` folder[\s\S]*branch restore/);
});
