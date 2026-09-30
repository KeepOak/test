import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createSign, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { outputUrl, packOutput, placeOutput, plainOutputName, unpackOutput, useBuiltOutput } from "../dist/desktop/build-output.js";
import { issuedByFulcio, outputWorkflowPath, outputWorkflowRef, verifyOutputBundle } from "../dist/desktop/build-output-proof.js";
import { compileChange } from "../dist/desktop/dev-build.js";

/**
 * A Beta change's build output is compiled once by GitHub and taken by the update instead of compiling on the owner's
 * computer, but only once its build-provenance record chains to Sigstore's certificate authority and names Branch's
 * build-output workflow on Beta's line and this exact change. Anything short of that compiles here, as before.
 */
const COMMIT = "a".repeat(40), OTHER = "b".repeat(40);
const REPO = "stabrea/Branch-Agent";
const file = (name, text = name) => ({ name, body: Buffer.from(text) });
const minimal = [file("dist/cli.js"), file("dist/desktop/main.js"), file("public/fonts/geist.woff2")];

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "branch-output-"));
  t.after(() => discardTemp(dir));
  return dir;
}

test("an output keeps exactly its files, and refuses names outside dist/ and public/fonts/ or that climb out", () => {
  const back = unpackOutput(packOutput(minimal));
  assert.deepEqual(back.map((one) => [one.name, one.body.toString()]), minimal.map((one) => [one.name, one.body.toString()]));
  for (const bad of ["../dist/cli.js", "dist/../x.js", "dist//x.js", "dist\\x.js", "/dist/x.js", "src/x.ts", "public/app/x.js", "dist/build-info.json", "C:/dist/x.js", "dist/./x"])
    assert.equal(plainOutputName(bad), false, bad);
  assert.throws(() => packOutput([...minimal, file("../evil.js")]), /cannot be in a build output/);
});

test("a cut-off, doubled or empty output is refused before anything is written", () => {
  const packed = packOutput(minimal);
  const raw = execFileSync(process.execPath, ["-e", "process.stdout.write(require('zlib').gunzipSync(Buffer.from(process.argv[1],'base64')))", packed.toString("base64")]);
  const gz = (buffer) => execFileSync(process.execPath, ["-e", "process.stdout.write(require('zlib').gzipSync(Buffer.from(process.argv[1],'base64')))", buffer.toString("base64")]);
  assert.throws(() => unpackOutput(gz(raw.subarray(0, raw.length - 3))), /not whole/);
  assert.throws(() => unpackOutput(gz(Buffer.concat([raw, raw]))), /may not/);
  assert.throws(() => unpackOutput(packOutput([file("dist/other.js")])), /no compiled app/);
});

test("placing an output replaces dist/ and public/fonts/ whole, drops tsc's build info and leaves the rest", async (t) => {
  const root = await temp(t);
  await mkdir(join(root, "dist", "stale"), { recursive: true });
  await writeFile(join(root, "dist", "stale", "old.js"), "old");
  await mkdir(join(root, ".build-cache"), { recursive: true });
  await writeFile(join(root, ".build-cache", "tsc.tsbuildinfo"), "{}");
  await mkdir(join(root, "public", "app"), { recursive: true });
  await writeFile(join(root, "public", "app", "main.js"), "window");
  await placeOutput(root, minimal);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), ["cli.js", "desktop"]);
  assert.equal(await readFile(join(root, "public", "app", "main.js"), "utf8"), "window");
  await assert.rejects(readdir(join(root, ".build-cache")));
});

// ---- the record: a real one from GitHub (cli/cli's own release, public) chains to the pinned Fulcio certificates ----

const real = JSON.parse(await readFile(new URL("./fixtures/sigstore-cli-bundle.json", import.meta.url), "utf8"));
const realDigest = "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8";

test("a real GitHub record chains to Sigstore's certificate authority, and only while its certificate was in date", () => {
  const leaf = new X509Certificate(Buffer.from(real.verificationMaterial.certificate?.rawBytes ?? real.verificationMaterial.x509CertificateChain.certificates[0].rawBytes, "base64"));
  const at = Number(real.verificationMaterial.tlogEntries[0].integratedTime) * 1000;
  assert.equal(issuedByFulcio(leaf, at), true);
  assert.equal(issuedByFulcio(leaf, at + 24 * 3600_000), false, "a day later the ten-minute certificate had expired");
});

test("a genuine record for another project's workflow is refused, and so is one about another file", () => {
  assert.throws(() => verifyOutputBundle(real, { digestHex: realDigest, commit: "0cf1092493af067646fc5f3db9421c6a6ec9c938" }), /not signed by Branch's build-output workflow/);
  assert.throws(() => verifyOutputBundle(real, { digestHex: "0".repeat(64), commit: COMMIT }), /different file/);
});

// ---- a made-up certificate authority stands in for Fulcio, so the whole way through can be signed here ----

function openssl() {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}

async function authority(t, san) {
  const dir = await temp(t);
  const run = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const ext = (name, text) => writeFile(join(dir, name), text);
  await ext("ca.ext", "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
  await ext("leaf.ext", `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectAltName=${san}\n`);
  for (const name of ["root", "mid", "leaf"]) run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  run("req", "-new", "-x509", "-key", "root.key", "-subj", "/O=test/CN=root", "-days", "2", "-out", "root.pem", "-extensions", "v3_ca");
  run("req", "-new", "-key", "mid.key", "-subj", "/O=test/CN=mid", "-out", "mid.csr");
  run("x509", "-req", "-in", "mid.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "2", "-extfile", "ca.ext", "-out", "mid.pem");
  run("req", "-new", "-key", "leaf.key", "-subj", "/O=test", "-out", "leaf.csr");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "mid.pem", "-CAkey", "mid.key", "-CAcreateserial", "-days", "1", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const read = (name) => readFile(join(dir, name), "utf8");
  return { root: new X509Certificate(await read("root.pem")), intermediate: new X509Certificate(await read("mid.pem")),
    leaf: new X509Certificate(await read("leaf.pem")), key: await read("leaf.key") };
}

const signer = `URI:https://github.com/${REPO}/${outputWorkflowPath}@${outputWorkflowRef}`;

function record(ca, { digest, commit = COMMIT, ref = outputWorkflowRef, path = outputWorkflowPath }) {
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "out", digest: { sha256: digest } }], predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { externalParameters: { workflow: { ref, repository: `https://github.com/${REPO}`, path } },
      resolvedDependencies: [{ uri: `git+https://github.com/${REPO}@${ref}`, digest: { gitCommit: commit } }] } } };
  const payload = Buffer.from(JSON.stringify(statement)), type = "application/vnd.in-toto+json";
  const pae = Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${payload.length} `), payload]);
  const sig = createSign("SHA256").update(pae).sign(ca.key).toString("base64");
  return { dsseEnvelope: { payload: payload.toString("base64"), payloadType: type, signatures: [{ sig }] },
    verificationMaterial: { certificate: { rawBytes: ca.leaf.raw.toString("base64") }, tlogEntries: [{ integratedTime: String(Math.floor(Date.now() / 1000)) }] } };
}

test("a record signed through the certificate authority for Branch's workflow, this line and this change is taken; nothing less is", { skip: !openssl() && "openssl is not on this computer" }, async (t) => {
  const ca = await authority(t, signer);
  const chain = { root: ca.root, intermediate: ca.intermediate };
  const digest = "c".repeat(64);
  assert.equal(verifyOutputBundle(record(ca, { digest }), { digestHex: digest, commit: COMMIT }, chain), signer.slice(4));
  assert.throws(() => verifyOutputBundle(record(ca, { digest, commit: OTHER }), { digestHex: digest, commit: COMMIT }, chain), /different change/);
  assert.throws(() => verifyOutputBundle(record(ca, { digest, ref: "refs/heads/other" }), { digestHex: digest, commit: COMMIT }, chain), /another workflow/);
  const tampered = record(ca, { digest });
  tampered.dsseEnvelope.signatures[0].sig = record(ca, { digest: "d".repeat(64) }).dsseEnvelope.signatures[0].sig;
  assert.throws(() => verifyOutputBundle(tampered, { digestHex: digest, commit: COMMIT }, chain), /signature does not check out/);
  assert.throws(() => verifyOutputBundle(record(ca, { digest }), { digestHex: digest, commit: COMMIT }), /not issued by Sigstore/, "the real Fulcio never issued this one");
  const other = await authority(t, "URI:https://github.com/someone/else/.github/workflows/beta-output.yml@refs/heads/redesign/window");
  assert.throws(() => verifyOutputBundle(record(other, { digest }), { digestHex: digest, commit: COMMIT }, { root: other.root, intermediate: other.intermediate }), /not signed by Branch's/);
});

/** GitHub as the update sees it: the output's address, and the attestation look-up by its digest. */
function github({ body, bundle, missingFor = 0, run }) {
  let asked = 0;
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/actions/runs?head_sha=") && run)
      return Response.json({ workflow_runs: [{ path: ".github/workflows/checks.yml", status: "in_progress" }, { path: ".github/workflows/beta-output.yml", ...run }] });
    if (String(url) === outputUrl(REPO, COMMIT)) return asked++ < missingFor || !body ? new Response("", { status: 404 }) : new Response(body);
    if (String(url).includes("/attestations/sha256:")) return bundle ? Response.json({ attestations: [{ bundle }] }) : new Response("", { status: 404 });
    return new Response("", { status: 500 });
  };
  return { fetch, calls };
}

test("the update waits for GitHub's build, takes it once it checks out, and compiles nothing", { skip: !openssl() && "openssl is not on this computer" }, async (t) => {
  const ca = await authority(t, signer);
  const body = packOutput(minimal), digest = createHash("sha256").update(body).digest("hex");
  const source = await temp(t);
  const slept = [];
  const got = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({ body, bundle: record(ca, { digest }), missingFor: 2 }),
    chain: { root: ca.root, intermediate: ca.intermediate }, sleep: async (ms) => { slept.push(ms); }, pollMs: 10, waitMs: 1000 });
  assert.equal(got.used, true);
  assert.equal(slept.length, 2, "it waited twice while GitHub was still building");
  assert.equal(await readFile(join(source, "dist", "cli.js"), "utf8"), "dist/cli.js");
});

test("an output that never arrives, has no record, or whose record is refused is not used, and dist/ is left alone", { skip: !openssl() && "openssl is not on this computer" }, async (t) => {
  const ca = await authority(t, signer);
  const body = packOutput(minimal), digest = createHash("sha256").update(body).digest("hex");
  const chain = { root: ca.root, intermediate: ca.intermediate };
  const source = await temp(t);
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "dist", "cli.js"), "compiled here");
  let clock = 0;
  const now = () => clock, sleep = async (ms) => { clock += ms; };
  const late = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({}), chain, now, sleep, pollMs: 100, waitMs: 1000 });
  assert.deepEqual(late, { used: false, why: "GitHub's build of this change did not arrive in time" });
  const unsigned = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({ body }), chain });
  assert.equal(unsigned.used, false);
  const wrong = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({ body, bundle: record(ca, { digest, commit: OTHER }) }), chain });
  assert.match(wrong.why, /different change/);
  assert.equal(await readFile(join(source, "dist", "cli.js"), "utf8"), "compiled here");
});

test("without a usable GitHub build the change is compiled here, exactly as before", async (t) => {
  const source = await temp(t);
  const ran = [], notes = [];
  const run = async (fileName, args) => { ran.push([fileName, ...args].join(" ")); return ""; };
  // A change id GitHub's build cannot be looked up for: nothing is asked of the network, and the build runs here.
  const where = await compileChange(run, { buildDir: source, commit: "not-a-change", note: (line) => notes.push(line),
    builtOutput: { repo: REPO, waitMs: 0 } }, source);
  assert.equal(where, "here");
  assert.deepEqual(ran, ["npm run build"]);
  assert.match(notes.at(-1), /^Compiling here: /);
  const plain = [];
  await compileChange(async (fileName, args) => { plain.push([fileName, ...args].join(" ")); return ""; }, { buildDir: source, commit: COMMIT }, source);
  assert.deepEqual(plain, ["npm run build"], "a plan that names no GitHub build never looks for one");
});

test("GitHub's build is waited for only while GitHub is building it: queued or failed, the change is compiled here at once", async (t) => {
  const source = await temp(t);
  let clock = 0;
  const now = () => clock, sleep = async (ms) => { clock += ms; };
  const queued = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({ run: { status: "queued" } }), now, sleep, pollMs: 100 });
  assert.deepEqual(queued, { used: false, why: "GitHub's build of this change has not started yet (its queue is busy)" });
  assert.equal(clock, 0, "nothing was waited for");
  const failed = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...github({ run: { status: "completed", conclusion: "failure" } }), now, sleep, pollMs: 100 });
  assert.match(failed.why, /did not finish/);
  clock = 0;
  const building = github({ run: { status: "in_progress" } });
  const waited = await useBuiltOutput({ repo: REPO, commit: COMMIT, source, ...building, now, sleep, pollMs: 10_000, waitMs: 150_000 });
  assert.match(waited.why, /did not arrive in time/);
  assert.equal(building.calls.filter((url) => url.includes("/actions/runs")).length, 3, "asked about the run once a minute, no more");
});
