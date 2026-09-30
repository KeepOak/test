/* PLAT-090: the release's source dependency inventory (scripts/release-sbom.mjs), made from this checkout's lockfile the
   way the release job makes it: npm's own CycloneDX output, named for the package whatever folder it ran in, bound to
   the exact commit and lockfile, with Electron in it and a checksum beside it. npm installs nothing (lockfile only). */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));

test("the release inventory names the package, binds the commit and lockfile, includes Electron, and has its checksum", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "branch-sbom-"));
  t.after(() => discardTemp(out));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  await run(process.execPath, ["scripts/release-sbom.mjs", repo, out, commit], { cwd: repo, timeout: 120_000 });
  const name = "Branch-Agent-source-dependencies.cdx.json";
  const body = await readFile(join(out, name), "utf8");
  const bom = JSON.parse(body);
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const lockBytes = await readFile(join(repo, "package-lock.json"));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.metadata.component.name, manifest.name, "named for the package, not the folder it ran in");
  const property = (key) => bom.metadata.properties.find((entry) => entry.name === key)?.value;
  assert.equal(property("branch:source-commit"), commit);
  assert.equal(property("branch:package-lock-sha256"), createHash("sha256").update(lockBytes).digest("hex"));
  const electron = JSON.parse(lockBytes).packages["node_modules/electron"].version;
  assert.ok(bom.components.some((component) => component.name === "electron" && component.version === electron));
  assert.equal(await readFile(join(out, `${name}.sha256`), "utf8"), `${createHash("sha256").update(body).digest("hex")}  ${name}\n`);
});

test("the inventory refuses anything but an exact commit", async () => {
  await assert.rejects(run(process.execPath, ["scripts/release-sbom.mjs", repo, tmpdir(), "main"], { cwd: repo }), /exact-commit/);
});
