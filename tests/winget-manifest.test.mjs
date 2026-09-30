/* PLAT-186 (WinGet part): review manifests for a stable release, made only from an installer whose bytes match its
   published checksum, naming the same identity the installer writes. Nothing is built, run or submitted: a fake
   installer file in a temporary folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { writeWingetManifests } from "../scripts/winget-manifest.mjs";
import { WINDOWS_SETUP } from "../scripts/package-installers.mjs";
import { windowsAppId } from "../dist/install/windows-identity.js";
import { publisher, uninstallKeyName } from "../dist/install/installer.js";

async function release(t, tamper = false) {
  const root = await mkdtemp(join(tmpdir(), "branch-winget-"));
  t.after(() => discardTemp(root));
  const dir = join(root, "release");
  await mkdir(dir);
  const bytes = Buffer.from("pretend installer");
  await writeFile(join(dir, WINDOWS_SETUP), bytes);
  const sum = createHash("sha256").update(tamper ? Buffer.from("other") : bytes).digest("hex");
  await writeFile(join(dir, `${WINDOWS_SETUP}.sha256`), `${sum}  ${WINDOWS_SETUP}\n`);
  return { root, dir, sum };
}

test("PLAT-186: three manifests for the checked installer, with the installer's own identity", async (t) => {
  const { root, dir, sum } = await release(t);
  const out = join(root, "review");
  const made = await writeWingetManifests({ version: "1.2.3", releaseDirectory: dir, outputDirectory: out });
  assert.equal(made.published, false);
  assert.deepEqual((await readdir(out)).sort(), [`${windowsAppId}.installer.yaml`, `${windowsAppId}.locale.en-US.yaml`, `${windowsAppId}.yaml`]);
  const installer = await readFile(join(out, `${windowsAppId}.installer.yaml`), "utf8");
  assert.match(installer, new RegExp(`InstallerSha256: ${sum.toUpperCase()}`));
  assert.match(installer, new RegExp(`releases/download/v1\\.2\\.3/${WINDOWS_SETUP.replaceAll(".", "\\.")}`));
  assert.match(installer, new RegExp(`ProductCode: "${uninstallKeyName}"`));
  assert.match(installer, new RegExp(`Publisher: "${publisher}"`));
  assert.match(installer, /Scope: user/);
  await assert.rejects(writeWingetManifests({ version: "1.2.3", releaseDirectory: dir, outputDirectory: out }), /EEXIST/, "review material is never overwritten");
});

test("PLAT-186: a checksum that does not match, or a prerelease version, makes no manifest", async (t) => {
  const bad = await release(t, true);
  await assert.rejects(writeWingetManifests({ version: "1.2.3", releaseDirectory: bad.dir, outputDirectory: join(bad.root, "out") }), /do not match/);
  const good = await release(t);
  await assert.rejects(writeWingetManifests({ version: "1.2.3-beta.1", releaseDirectory: good.dir, outputDirectory: join(good.root, "out") }), /stable x\.y\.z/);
});
