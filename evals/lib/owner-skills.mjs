import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const below = (root, file) => { const part = relative(root, file); return !part || (!part.startsWith("..") && !isAbsolute(part)); };

/** Explicit exported files only: never discover or open the owner's installed data. */
export async function loadOwnerSkills(paths, scratch, side) {
  if (!["none", "with", "without"].includes(side)) throw new Error("Skill side must be none, with or without.");
  if (!Array.isArray(paths) || paths.length > 10 || paths.some((file) => typeof file !== "string" || !file))
    throw new Error("Supply at most ten explicit skill package paths.");
  if ((side === "none") !== (paths.length === 0)) throw new Error("Paired skill sides require explicit exported packages.");
  if (!paths.length) return { skills: [], provenance: { source: "none", side, count: 0, setHash: null } };
  const { readSkillPackage, maxPackageBytes } = await import("../../dist/skill-package.js");
  const scratchPath = await realpath(scratch).catch(() => resolve(scratch));
  const skills = [], seen = new Set();
  for (const file of paths) {
    const full = await realpath(file);
    if (below(scratchPath, full)) throw new Error("Exported packages must stay outside the disposable evaluation scratch folder.");
    const handle = await open(full, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxPackageBytes) throw new Error("Selected skill package exceeds the file limit.");
      const bytes = Buffer.alloc(maxPackageBytes + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > maxPackageBytes) throw new Error("Selected skill package exceeds the file limit.");
      const raw = bytes.subarray(0, read.bytesRead), { manifest, files } = readSkillPackage(raw);
      if (seen.has(manifest.name)) throw new Error("Selected packages have duplicate skill names.");
      seen.add(manifest.name);
      skills.push({ document: files["SKILL.md"], packageVersion: manifest.packageVersion,
        packageHash: digest(raw), documentHash: digest(files["SKILL.md"]), omittedFiles: Object.keys(files).filter((name) => name !== "SKILL.md").length });
    } finally { await handle.close(); }
  }
  const sources = skills.map(({ packageHash, documentHash, packageVersion, omittedFiles }) => ({ packageHash, documentHash, packageVersion, omittedFiles }));
  sources.sort((a, b) => a.packageHash.localeCompare(b.packageHash));
  skills.sort((a, b) => a.packageHash.localeCompare(b.packageHash));
  return { skills, provenance: { source: "explicit-owner-exported-packages", side, scope: "SKILL.md-only", count: skills.length,
    setHash: digest(JSON.stringify(sources)), sources } };
}

/** Repack instructions alone, scan/install switched off, then activate without overriding findings. */
export async function installOwnerSkills(engine, fixture) {
  if (fixture.provenance.side !== "with") return;
  const { packSkill } = await import("../../dist/skill-package.js");
  const policy = await engine.api("skills/policy");
  if (policy.policy !== "block") throw new Error("The isolated skill fixture requires the default blocking scan policy.");
  for (const skill of fixture.skills) {
    const file = packSkill({ files: { "SKILL.md": skill.document }, author: "Explicit evaluation fixture", packageVersion: skill.packageVersion });
    const installed = await engine.api("skills/package/install", { file: file.toString("base64"), approve: true, allow: [] });
    const view = installed.skill;
    if (!installed.installed || !view || view.activeVersion !== null || view.findings?.length)
      throw new Error("The selected skill did not arrive clean and switched off in the isolated engine.");
    await engine.api(`skills/${view.id}/activate`, { version: view.headVersion, expectedRevision: view.revision });
  }
}

/** Old cards and changed corpora never supply a comparable nightly trend. */
export function comparableSkillRun(current, previous) {
  const left = current.ownerSkills ?? { source: "none", side: "none", count: 0, setHash: null };
  const right = previous.ownerSkills ?? { source: "none", side: "none", count: 0, setHash: null };
  return left.side === right.side && left.setHash === right.setHash && left.scope === right.scope;
}
