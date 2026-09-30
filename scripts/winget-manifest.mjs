#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// Matches windowsAppId, installer ARP metadata and package-installers.mjs; imports no packaging runtime.
const identifier = "KeepOak.BranchAgent", publisher = "Branch Agent";
const installer = "Branch-Agent-Setup-windows-x64.exe";
const repository = "https://github.com/KeepOak/Branch-Agent";
const manifestVersion = "1.12.0";
const quote = (value) => JSON.stringify(value);
const common = (version) => `PackageIdentifier: ${quote(identifier)}\nPackageVersion: ${quote(version)}\n`;
const finish = (type) => `ManifestType: ${type}\nManifestVersion: ${manifestVersion}\n`;

async function checkedInstaller(directory) {
  const text = await readFile(join(directory, `${installer}.sha256`), "utf8");
  const checksum = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/i.exec(text);
  if (!checksum || checksum[2] !== installer) throw new Error("The installer checksum must name the exact Windows setup asset.");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(join(directory, installer))) hash.update(bytes);
  const actual = hash.digest("hex");
  if (actual !== checksum[1].toLowerCase()) throw new Error("The installer bytes do not match their release checksum.");
  return actual.toUpperCase();
}

/** Generate review material only: no network, packaging, installer, WinGet, repository or publication commands. */
export async function writeWingetManifests({ version, releaseDirectory, outputDirectory }) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Choose an explicit stable x.y.z release version; prereleases are not submitted by this generator.");
  if (!releaseDirectory || !outputDirectory) throw new Error("Specify the existing release directory and a new output directory.");
  const checksum = await checkedInstaller(resolve(releaseDirectory));
  const base = common(version);
  const installerYaml = base + [
    "InstallerType: inno", "Scope: user", "UpgradeBehavior: install",
    "InstallModes:", "  - interactive", "  - silent", "  - silentWithProgress",
    "AppsAndFeaturesEntries:", `  - DisplayName: ${quote("Branch Agent")}`,
    `    Publisher: ${quote(publisher)}`, `    DisplayVersion: ${quote(version)}`,
    `    ProductCode: ${quote("BranchAgent")}`,
    "Installers:", "  - Architecture: x64",
    `    InstallerUrl: ${quote(`${repository}/releases/download/v${version}/${installer}`)}`,
    `    InstallerSha256: ${checksum}`, "",
  ].join("\n") + finish("installer");
  const localeYaml = base + [
    "PackageLocale: en-US", `Publisher: ${quote(publisher)}`,
    `PackageName: ${quote("Branch Agent")}`, `PackageUrl: ${quote(repository)}`,
    "License: MIT", `LicenseUrl: ${quote(`${repository}/blob/v${version}/LICENSE`)}`,
    `ShortDescription: ${quote("A local, inspectable personal assistant runtime.")}`, "",
  ].join("\n") + finish("defaultLocale");
  const versionYaml = base + "DefaultLocale: en-US\n" + finish("version");
  // Exclusive directory creation refuses an existing version/output and avoids overwriting review material.
  const destination = resolve(outputDirectory);
  await mkdir(destination, { recursive: false });
  for (const [name, text] of [[`${identifier}.installer.yaml`, installerYaml], [`${identifier}.locale.en-US.yaml`, localeYaml], [`${identifier}.yaml`, versionYaml]])
    await writeFile(join(destination, name), text, { encoding: "utf8", flag: "wx" });
  return { directory: destination, version, installerSha256: checksum, files: 3, published: false };
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: "string" }, "release-dir": { type: "string" }, out: { type: "string" } }, strict: true });
  const result = await writeWingetManifests({ version: values.version, releaseDirectory: values["release-dir"], outputDirectory: values.out });
  console.log(`Wrote ${result.files} review manifests to ${result.directory}. Nothing was submitted. Validate the stable release URL, signed installer and installed ARP metadata before requesting a WinGet listing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
