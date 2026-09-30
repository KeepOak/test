import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

// npm's documented CycloneDX generator supplies the dependency graph; no extra release dependency.
// https://docs.npmjs.com/cli/v11/commands/npm-sbom/
const exec = promisify(execFile);
const [sourceArg, downloadsArg, commit] = process.argv.slice(2);
if (!sourceArg || !downloadsArg || !/^[0-9a-f]{40}$/.test(commit ?? ""))
  throw new Error("Usage: release-sbom.mjs <source> <downloads> <exact-commit>");
const source = resolve(sourceArg), downloads = resolve(downloadsArg);
const lockBytes = await readFile(join(source, "package-lock.json"));
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
// On Windows npm is a .cmd, which only a shell starts; every argument here is fixed, so nothing reaches that shell.
const { stdout } = await exec("npm", ["sbom", "--package-lock-only", "--sbom-format=cyclonedx", "--include=dev", "--include=optional", "--ignore-scripts"],
  { cwd: source, encoding: "utf8", maxBuffer: 16 << 20, timeout: 60_000, windowsHide: true, shell: process.platform === "win32" });
const bom = JSON.parse(stdout);
const root = bom.metadata?.component;
// npm names the root component after the folder it ran in (the release job checks out into "source"); its bom-ref and
// purl carry the package's own name, so those are what is checked, and the name is set to the package's.
if (bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components) || !bom.components.length
  || root?.["bom-ref"] !== `${manifest.name}@${manifest.version}` || root?.version !== manifest.version)
  throw new Error("npm did not produce the release's dependency inventory; nothing may be published.");
root.name = manifest.name;
const lock = JSON.parse(lockBytes);
const electron = lock.packages?.["node_modules/electron"]?.version;
if (!electron || !bom.components.some((component) => component.name === "electron" && component.version === electron))
  throw new Error("The source inventory must include the exact desktop Electron dependency.");
bom.metadata.properties = [
  ...(bom.metadata.properties ?? []),
  { name: "branch:source-commit", value: commit },
  { name: "branch:package-lock-sha256", value: createHash("sha256").update(lockBytes).digest("hex") },
  { name: "branch:inventory-scope", value: "Locked source dependencies, including build dependencies and Electron. Native bundled libraries, downloaded models, add-ons and mobile dependencies are not inventoried here." },
];
const name = "Branch-Agent-source-dependencies.cdx.json";
const body = `${JSON.stringify(bom, null, 2)}\n`;
await mkdir(downloads, { recursive: true });
await writeFile(join(downloads, name), body);
await writeFile(join(downloads, `${name}.sha256`), `${createHash("sha256").update(body).digest("hex")}  ${name}\n`);
console.log(`Recorded ${bom.components.length} locked source dependencies for ${manifest.version} (${commit.slice(0, 8)}).`);
