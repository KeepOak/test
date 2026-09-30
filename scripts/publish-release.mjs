#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const downloads = [
  "Branch-Agent-windows-x64.zip",
  "Branch-Agent-macos-arm64.zip",
  "Branch-Agent-macos-x64.zip",
  "Branch-Agent-linux-x64.tar.gz",
];
/** The installers (scripts/package-installers.mjs installerNames), each with its checksum. */
const installers = [
  "Branch-Agent-Setup-windows-x64.exe",
  "Branch-Agent-macos-arm64.dmg",
  "Branch-Agent-macos-x64.dmg",
  "Branch-Agent-linux-x64.deb",
  "Branch-Agent-linux-x64.AppImage",
];

function groups(tag) {
  const cli = `branch-agent-${tag.slice(1)}.tgz`;
  return [
    ...[...downloads, ...installers].map((name) => [name, `${name}.sha256`]),
    [cli, `${cli}.sha256`],
    ["Branch-Agent-source-dependencies.cdx.json", "Branch-Agent-source-dependencies.cdx.json.sha256"],
    ["Install Branch Agent.cmd"],
    ["install-branch-agent.sh"],
  ];
}

export const releaseFiles = (tag) => groups(tag).flat();
export const remoteName = (name) => name.replace(/[^A-Za-z0-9._-]/g, ".");

async function defaultGh(args, { allowFailure = false } = {}) {
  try {
    const answer = await execFileAsync("gh", args, { encoding: "utf8", windowsHide: true });
    return { code: 0, stdout: answer.stdout, stderr: answer.stderr };
  } catch (error) {
    const result = { code: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
    if (allowFailure) return result;
    throw new Error(result.stderr.trim() || `gh ${args.slice(0, 2).join(" ")} failed`);
  }
}

async function checked(gh, args) {
  const answer = await gh(args);
  if (answer.code !== 0) throw new Error(answer.stderr.trim() || `gh ${args.slice(0, 2).join(" ")} failed`);
  return answer;
}

async function readRelease(gh, tag, repo) {
  const answer = await gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"], { allowFailure: true });
  if (answer.code !== 0) return null;
  return JSON.parse(answer.stdout);
}

async function verifyInputs(tag, source, directory) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const notes = join(source, "docs", "agents", "briefs", `release-notes-${tag.slice(1)}.md`);
  for (const name of releaseFiles(tag)) await access(join(directory, name));
  if (!(await readFile(notes, "utf8")).trim()) throw new Error(`Release notes are empty: ${notes}`);
  return notes;
}

function missingGroups(release, tag) {
  const attached = new Set((release.assets ?? []).map((asset) => asset.name));
  return groups(tag).filter((group) => {
    const present = group.filter((name) => attached.has(remoteName(name))).length;
    if (present > 0 && present < group.length)
      throw new Error(`Release has only part of the required asset group: ${group.join(" + ")}`);
    return present === 0;
  });
}

export async function publishRelease({ tag, repo, downloads: directory, source, gh = defaultGh }) {
  const notes = await verifyInputs(tag, source, directory);
  const prerelease = tag.slice(1).split("+", 1)[0].includes("-");
  let release = await readRelease(gh, tag, repo);
  if (!release) {
    const create = ["release", "create", tag, "--repo", repo, "--draft", "--verify-tag",
      "--title", `Branch Agent ${tag.slice(1)}`, "--notes-file", notes];
    if (prerelease) create.push("--prerelease");
    await checked(gh, create);
    release = await readRelease(gh, tag, repo);
  }
  const missing = missingGroups(release, tag);
  if (!release.isDraft && missing.length) throw new Error("A published release is missing required assets; refusing to modify it.");
  for (const group of missing)
    await checked(gh, ["release", "upload", tag, "--repo", repo, ...group.map((name) => join(directory, name))]);
  release = await readRelease(gh, tag, repo);
  const absent = releaseFiles(tag).filter((name) => !(release.assets ?? []).some((asset) => asset.name === remoteName(name)));
  if (absent.length) throw new Error(`Release is still missing required assets: ${absent.join(", ")}`);
  const edit = prerelease
    ? ["release", "edit", tag, "--repo", repo, "--notes-file", notes, "--draft=false", "--prerelease"]
    : ["release", "edit", tag, "--repo", repo, "--notes-file", notes, "--draft=false", "--prerelease=false"];
  await checked(gh, edit);
  return { tag, notes, assets: releaseFiles(tag) };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    tag: { type: "string" }, repo: { type: "string" }, downloads: { type: "string" }, source: { type: "string" },
  } });
  for (const name of ["tag", "repo", "downloads", "source"])
    if (!values[name]) throw new Error(`Missing --${name}`);
  await publishRelease({ tag: values.tag, repo: values.repo, downloads: values.downloads, source: values.source });
}
