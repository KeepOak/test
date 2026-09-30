import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sections = [
  "# Third-party notices",
  "",
  "Branch Agent application code is MIT licensed. Distributed dependencies retain their own licenses and notices. This file collects notices from the pinned runtime dependency packages; their original files are also retained in the desktop package.",
  "",
  "Electron distributions additionally include LICENSE and LICENSES.chromium.html. Font notices accompany the generated files in public/fonts. Build dependencies are recorded in package-lock.json and retain notices in node_modules.",
  "",
  // Browser bundles vendored under public/app/vendor are not in package-lock.json, so their notices are written here.
  "The browser also includes the pinned markdown-it 15.0.2 ESM bundle (MIT) at",
  "`public/app/vendor/markdown-it-15.0.2/markdown-it.js`. Its upstream license and",
  "the notices for bundled entities (BSD-2-Clause), linkify-it, mdurl, punycode.js",
  "and uc.micro (MIT) are retained alongside the bundle. See that folder's README",
  "for the official package source, version and checksum.",
  "",
  "The browser also includes the unchanged DOMPurify 3.4.16 ES module (Cure53 and",
  "contributors, Apache-2.0 or MPL-2.0; used here under Apache-2.0) at",
  "`public/app/vendor/dompurify-3.4.16/purify.js`, with its upstream license banner and",
  "Apache `LICENSE` retained alongside. See that folder's README for the source commit",
  "and checksum.",
  "",
];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev) continue;
  const metadata = JSON.parse(
    await readFile(join(path, "package.json"), "utf8"),
  );
  const names = (await readdir(path)).filter((name) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(name),
  );
  if (!names.length)
    throw new Error(`No top-level license notice for ${metadata.name}`);
  sections.push(
    `## ${metadata.name} ${metadata.version}`,
    "",
    `Declared license: ${metadata.license ?? "see notice"}`,
    "",
  );
  for (const name of names)
    sections.push(
      `### ${name}`,
      "",
      await readFile(join(path, name), "utf8"),
      "",
    );
}
// The hand-written section for source code adapted from other projects is not in any package;
// it is carried over from the current file so regenerating never drops it.
const adaptedHeading = "## Source code adapted from other projects";
const current = await readFile("THIRD_PARTY_NOTICES.md", "utf8").catch(() => "");
const adapted = current.indexOf(`\n${adaptedHeading}\n`);
if (adapted >= 0) sections.push(current.slice(adapted + 1).trimEnd(), "");
await writeFile("THIRD_PARTY_NOTICES.md", sections.join("\n").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, ""));
console.log("Collected notices from locked runtime dependencies.");
