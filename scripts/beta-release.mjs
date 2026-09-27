#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** The repository Beta publishes from: the one this workflow runs in, when it is Branch's own under either name
 *  (it is moving from stabrea to KeepOak); any other repository, a fork included, is not Branch's. */
const trustedRepos = new Set(["KeepOak/Branch-Agent", "stabrea/Branch-Agent"]);
const canonical = trustedRepos.has(process.env.GITHUB_REPOSITORY ?? "") ? process.env.GITHUB_REPOSITORY : "stabrea/Branch-Agent";
const branch = "mac/cross-platform";
const archives = ["Branch-Agent-windows-x64.zip", "Branch-Agent-macos-arm64.zip",
  "Branch-Agent-macos-x64.zip", "Branch-Agent-linux-x64.tar.gz"];
const shaPattern = /^[a-f0-9]{40}$/;

export function betaPlan(version, runNumber) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || !Number.isSafeInteger(runNumber) || runNumber < 1)
    throw new Error("Beta requires a final package version and positive workflow run number.");
  if (match.slice(1).some((part) => !Number.isSafeInteger(Number(part))))
    throw new Error("Package version exceeds safe integer range.");
  const next = Number(match[3]) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Next patch version exceeds safe integer range.");
  const beta = `${match[1]}.${match[2]}.${next}-beta.${runNumber}`;
  return { version: beta, tag: `v${beta}` };
}

export function latestTrustedChecks(payload, sha, repo = canonical) {
  if (!shaPattern.test(sha) || repo !== canonical) throw new Error("Invalid beta source identity.");
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const trusted = runs.filter((run) =>
    run.path === ".github/workflows/checks.yml" &&
    (run.event === "push" || run.event === "workflow_dispatch") &&
    run.head_branch === branch && run.head_sha === sha &&
    run.repository?.full_name === repo && run.head_repository?.full_name === repo &&
    Number.isSafeInteger(run.id) && run.id > 0);
  const run = trusted.sort((a, b) => b.id - a.id)[0] ?? null;
  return { run, state: !run ? "missing" : run.status !== "completed" ? "pending" :
    run.conclusion === "success" ? "accepted" : "rejected" };
}

export function latestTrustedFast(payload, sha, repo, headBranch) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const trusted = runs.filter((run) =>
    run.path === ".github/workflows/pr-fast.yml" && run.event === "pull_request" &&
    run.head_sha === sha && run.head_branch === headBranch && run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    Number.isSafeInteger(run.id) && run.id > 0);
  return trusted.sort((a, b) => b.id - a.id)[0] ?? null;
}

/** The newest whole-suite (checks.yml) run for a pull request's exact head, from this repository. */
export function latestTrustedSuite(payload, sha, repo, headBranch) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const trusted = runs.filter((run) =>
    run.path === ".github/workflows/checks.yml" && run.event === "pull_request" &&
    run.head_sha === sha && run.head_branch === headBranch && run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    Number.isSafeInteger(run.id) && run.id > 0);
  return trusted.sort((a, b) => b.id - a.id)[0] ?? null;
}

export function approvedExactHead(reviews, pull) {
  const latest = new Map();
  for (const review of reviews) {
    const user = review.user;
    const login = user?.login;
    const trustedHuman = user?.type !== "Bot" &&
      ["OWNER", "MEMBER", "COLLABORATOR"].includes(review.author_association);
    // This scoped App may record a real independent review; no other NONE-associated bot qualifies.
    const trustedApp = user?.type === "Bot" && user.login === "keepoak-branch-reviewer[bot]" &&
      user.id === 332788682;
    if (!login || login === pull.user.login || review.commit_id !== pull.head.sha ||
        !(trustedHuman || trustedApp)) continue;
    if ((latest.get(login)?.id ?? 0) < review.id) latest.set(login, review);
  }
  return [...latest.values()].some((review) => review.state === "APPROVED") &&
    ![...latest.values()].some((review) => review.state === "CHANGES_REQUESTED");
}

async function mergeHeadCurrent(sha, pullHead, repo, gh) {
  if (!shaPattern.test(pullHead)) return false;
  const merge = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/commits/${sha}`]));
  const base = merge.parents?.[0]?.sha;
  // Only a two-parent merge links the reviewed head to this exact integration commit.
  // Squash and rebase merges take the exhaustive acceptance lane instead.
  if (merge.sha !== sha || merge.parents?.length !== 2 ||
      !shaPattern.test(base) || merge.parents[1]?.sha !== pullHead) return false;
  const reviewed = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/commits/${pullHead}`]));
  const reviewedTree = reviewed.commit?.tree?.sha;
  if (reviewed.sha !== pullHead || !shaPattern.test(reviewedTree) ||
      merge.commit?.tree?.sha !== reviewedTree) return false;
  const comparison = JSON.parse(await gh(["api", "--method", "GET",
    `repos/${repo}/compare/${base}...${pullHead}`]));
  return comparison.behind_by === 0;
}

export async function fastProof(sha, repo = canonical, gh = github) {
  if (!shaPattern.test(sha) || repo !== canonical) throw new Error("Invalid beta source identity.");
  const pulls = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/commits/${sha}/pulls`,
    "-f", "per_page=100"]));
  const merged = pulls.filter((pull) => pull.merged_at && pull.merge_commit_sha === sha &&
    pull.base?.ref === branch && pull.base?.repo?.full_name === repo && pull.head?.repo?.full_name === repo);
  if (merged.length !== 1) return null;
  const pull = merged[0];
  if (!await mergeHeadCurrent(sha, pull.head.sha, repo, gh)) return null;
  const reviews = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/pulls/${pull.number}/reviews`,
    "-f", "per_page=100"]));
  if (!approvedExactHead(reviews, pull)) return null;
  const response = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/actions/workflows/pr-fast.yml/runs`,
    "-f", `head_sha=${pull.head.sha}`, "-f", "per_page=100"]));
  const run = latestTrustedFast(response, pull.head.sha, repo, pull.head.ref);
  if (run?.status !== "completed" || run.conclusion !== "success") return null;
  // GitHub clears workflow_run.pull_requests after a PR merges. The PR's own check rollup still
  // binds its verify-fast job to the exact workflow run, so require that link as well.
  const checks = JSON.parse(await gh(["pr", "checks", String(pull.number), "--repo", repo,
    "--json", "name,state,workflow,link"]));
  const bound = checks.some((check) => check.name === "verify-fast" && check.workflow === "PR Fast Checks" &&
    check.state === "SUCCESS" && check.link?.includes(`/actions/runs/${run.id}/job/`));
  if (!bound) return null;
  // verify-fast leaves a broad change to the whole suite, which runs on the pull request itself. So the fast lane
  // also needs that suite's newest run for the exact reviewed head to have passed.
  const suites = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/actions/workflows/checks.yml/runs`,
    "-f", `head_sha=${pull.head.sha}`, "-f", "event=pull_request", "-f", "per_page=100"]));
  const suite = latestTrustedSuite(suites, pull.head.sha, repo, pull.head.ref);
  if (suite?.status !== "completed" || suite.conclusion !== "success") return null;
  return { kind: "reviewed-fast", run, pullNumber: pull.number, pullHead: pull.head.sha };
}

export async function stampBetaVersion(root, version) {
  if (!/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) throw new Error("Invalid beta version.");
  await stampPackageVersion(root, version);
}

/** Gives the package and its lockfile one prerelease version, for packaging only (never committed). */
export async function stampPackageVersion(root, version) {
  const manifestPath = join(root, "package.json"), lockPath = join(root, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (manifest.name !== "branch-agent" || lock.name !== manifest.name ||
      lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version)
    throw new Error("Package and lockfile identities disagree before beta stamping.");
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

export async function betaAssets(directory) {
  const assets = {};
  for (const name of archives) {
    const archive = join(directory, name);
    const checksum = (await readFile(join(directory, `${name}.sha256`), "utf8")).trim();
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const digest = hash.digest("hex");
    if (checksum !== `${digest}  ${name}` && checksum !== `${digest} *${name}`)
      throw new Error(`Checksum does not match ${name}.`);
    assets[name] = { sha256: digest, bytes: (await stat(archive)).size };
  }
  return assets;
}

async function github(args) {
  const result = await exec("gh", args, { encoding: "utf8", windowsHide: true, maxBuffer: 8_000_000 });
  return result.stdout.trim();
}

async function currentProof(sha, proof, repo, gh) {
  const ref = JSON.parse(await gh(["api", `repos/${repo}/git/ref/heads/${branch}`]));
  if (ref.object?.sha !== sha) return false;
  if (proof.kind === "reviewed-fast") {
    const current = await fastProof(sha, repo, gh);
    return current?.run.id === proof.run.id && current.pullHead === proof.pullHead;
  }
  const response = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/actions/workflows/checks.yml/runs`,
    "-f", `head_sha=${sha}`, "-f", "per_page=100"]));
  const current = latestTrustedChecks(response, sha, repo);
  return current.state === "accepted" && current.run.id === proof.run.id;
}

async function releaseHistory(repo, gh) {
  const releases = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = JSON.parse(await gh(["api", "--method", "GET", `repos/${repo}/releases`,
      "-f", "per_page=100", "-f", `page=${page}`]));
    if (!Array.isArray(batch)) throw new Error("GitHub release history was incomplete.");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("GitHub release history exceeded the checked range; refusing to publish out of order.");
}

function stableAtOrBeyondBeta(releases, tag) {
  const base = tag.match(/^v(\d+)\.(\d+)\.(\d+)-beta\./).slice(1).map(Number);
  return releases.some((entry) => {
    if (entry.draft || entry.prerelease) return false;
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(entry.tag_name);
    if (!match) return false;
    const stable = match.slice(1).map(Number);
    for (let i = 0; i < 3; i++) if (stable[i] !== base[i]) return stable[i] > base[i];
    return true;
  });
}

export async function publishBeta({ tag, sha, proof, repo = canonical, directory, workflowUrl, gh = github }) {
  if (repo !== canonical || !shaPattern.test(sha) || !/^v\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(tag) ||
      !proof?.run || proof.run.conclusion !== "success" || !Number.isSafeInteger(proof.run.id) ||
      !["reviewed-fast", "exhaustive"].includes(proof.kind))
    throw new Error("Beta publication identity is invalid.");
  const assets = await betaAssets(directory);
  if (!(await currentProof(sha, proof, repo, gh)))
    return { skipped: "Integration tip or acceptance proof changed before publication." };
  const releases = await releaseHistory(repo, gh);
  const existing = releases.find((entry) => entry.tag_name === tag);
  if (existing) throw new Error(`Beta tag ${tag} already has a release; refusing to overwrite it.`);
  const betaNumbers = releases.filter((entry) => entry.prerelease && /^v\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(entry.tag_name))
    .map((entry) => Number(entry.tag_name.match(/-beta\.(\d+)$/)[1]));
  if (betaNumbers.some((number) => number >= Number(tag.match(/-beta\.(\d+)$/)[1])))
    return { skipped: "This beta run is not newer than a published beta." };
  if (stableAtOrBeyondBeta(releases, tag))
    return { skipped: "A final stable version already supersedes this beta." };
  const notes = `Opt-in beta build from accepted integration commit ${sha}.\n\n` +
    `Acceptance: ${proof.kind}; gate run: ${proof.run.html_url}\nPublisher run: ${workflowUrl}\n\n` +
    `The reviewed-fast lane accepts the pull request's own whole-suite run rather than a run on this merge commit. ` +
    `Stable users remain on the stable channel.`;
  await gh(["api", "--method", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`]);
  await gh(["release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--prerelease",
    "--latest=false", "--title", `Branch Agent ${tag.slice(1)} (beta)`, "--notes", notes]);
  const provenance = { schema: 1, channel: "beta", tag, version: tag.slice(1), sourceSha: sha,
    acceptance: proof.kind, acceptanceRunId: proof.run.id, acceptanceRunAttempt: proof.run.run_attempt,
    acceptanceRunUrl: proof.run.html_url, pullNumber: proof.pullNumber ?? null, pullHead: proof.pullHead ?? null,
    publisherRunUrl: workflowUrl, assets };
  const provenancePath = join(directory, "branch-beta-provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  const files = [...archives.flatMap((name) => [name, `${name}.sha256`]), "branch-beta-provenance.json"];
  await gh(["release", "upload", tag, "--repo", repo, ...files.map((name) => join(directory, name))]);
  const release = JSON.parse(await gh(["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"]));
  const attached = new Set((release.assets ?? []).map((asset) => asset.name));
  if (!release.isDraft || files.some((name) => !attached.has(basename(name))))
    throw new Error("Beta draft is incomplete; refusing to publish it.");
  if (!(await currentProof(sha, proof, repo, gh)))
    throw new Error("Integration tip or acceptance proof changed after upload; draft was not published.");
  await gh(["release", "edit", tag, "--repo", repo, "--draft=false", "--prerelease", "--latest=false"]);
  return { tag, assets: files, sourceSha: sha };
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "plan") {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    console.log(JSON.stringify(betaPlan(manifest.version, Number(values[0]))));
  } else if (command === "stamp") {
    await stampBetaVersion(process.cwd(), values[0]);
  } else if (command === "gate") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const result = latestTrustedChecks(JSON.parse(input), values[0], values[1]);
    if (result.state === "accepted") console.log(JSON.stringify({ id: result.run.id }));
    else process.exitCode = result.state === "pending" || result.state === "missing" ? 2 : 1;
  } else if (command === "fast-proof") {
    const proof = await fastProof(values[0], values[1]);
    if (proof) console.log(JSON.stringify({ kind: proof.kind, run: { id: proof.run.id } }));
    else process.exitCode = 1;
  } else if (command === "publish") {
    const [tag, sha, kind, runId, directory, workflowUrl] = values;
    const proof = kind === "reviewed-fast" ? await fastProof(sha) : await (async () => {
      const response = JSON.parse(await github(["api", "--method", "GET", `repos/${canonical}/actions/workflows/checks.yml/runs`,
        "-f", `head_sha=${sha}`, "-f", "per_page=100"]));
      const result = latestTrustedChecks(response, sha);
      return result.state === "accepted" ? { kind: "exhaustive", run: result.run } : null;
    })();
    if (!proof || String(proof.run.id) !== runId) throw new Error("Acceptance proof changed before publication.");
    console.log(JSON.stringify(await publishBeta({ tag, sha, proof, directory, workflowUrl })));
  } else throw new Error(`Unknown beta command: ${command}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
