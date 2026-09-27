import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, sign as cryptoSign } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { makeWorkflowCertificate } from "./helpers-provenance-cert.mjs";
import { fetchAttestationBundles, isBuildProvenance, verifyAttestationBundle } from "../dist/desktop/provenance.js";
import { LAST_RELEASE_WITHOUT_PROVENANCE, PROVENANCE_WORDS, UpdateDeferredError, Updater, provenanceRequired } from "../dist/desktop/updater.js";

const run = promisify(execFile);
const windows = process.platform === "win32";
const repo = "stabrea/Branch-Agent";
// What Fulcio names when Branch's own release workflow (.github/workflows/package.yml) runs for a tag.
const workflowUri = `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.3.0`;
// Where GitHub keeps externalised bundles (seen live: `gh api repos/cli/cli/attestations/sha256:<digest>`).
const blobHost = "https://tmaproduction.blob.core.windows.net";
/** A fetch that sends GitHub's API and blob addresses to a local test server instead. */
const viaLocal = (origin) => (url, init) => fetch(url.replace("https://api.github.com", origin()).replace(blobHost, origin()), init);

/** DSSE Pre-Authentication Encoding, built the same way `src/desktop/provenance.ts` builds it. */
function dssePae(payloadType, payload) {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type, Buffer.from(` ${payload.length} `, "utf8"), payload]);
}

/**
 * A real, signed Sigstore-shaped bundle for `digestHex`, issued by a freshly made test certificate.
 * `integratedTime` (unix seconds) is the moment the transparency log says the bundle was signed,
 * the same field the real world uses to check a short-lived certificate's window; it defaults to a
 * moment inside that window, matching how a genuine bundle always looks.
 */
function makeBundle(digestHex, { uri = workflowUri, notBefore, notAfter, integratedTime, predicateType = "https://slsa.dev/provenance/v1", logged = true } = {}) {
  const window = { notBefore: notBefore ?? new Date(Date.now() - 60_000), notAfter: notAfter ?? new Date(Date.now() + 600_000) };
  const { certificateDer, privateKey } = makeWorkflowCertificate({ workflowUri: uri, ...window });
  const signedAt = integratedTime ?? Math.floor((window.notBefore.getTime() + window.notAfter.getTime()) / 2 / 1000);
  const payloadType = "application/vnd.in-toto+json";
  const payload = Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "Branch-Agent-windows-x64.zip", digest: { sha256: digestHex } }],
    predicateType,
    predicate: {},
  }), "utf8");
  const signature = cryptoSign("sha256", dssePae(payloadType, payload), privateKey);
  return {
    dsseEnvelope: { payload: payload.toString("base64"), payloadType, signatures: [{ sig: signature.toString("base64"), keyid: "" }] },
    verificationMaterial: {
      certificate: { rawBytes: certificateDer.toString("base64") },
      ...(logged ? { tlogEntries: [{ integratedTime: String(signedAt) }] } : {}),
    },
  };
}

/**
 * The shape of GitHub's own release attestation, as served live for a cli/cli release: an in-toto
 * statement about this same file, with predicateType `https://in-toto.io/attestation/release/v0.2`,
 * signed by a certificate naming `https://dotcom.releases.github.com` (not a workflow) and carrying
 * no transparency-log entry. With immutable releases on, GitHub publishes one for every release asset.
 */
const makeReleaseAttestation = (digestHex) => makeBundle(digestHex, {
  uri: "https://dotcom.releases.github.com", predicateType: "https://in-toto.io/attestation/release/v0.2", logged: false,
});

test("verifyAttestationBundle accepts a real bundle for this file and this repository", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const result = verifyAttestationBundle(makeBundle(digestHex), { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("verifyAttestationBundle refuses a bundle for a different file", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const otherDigest = createHash("sha256").update("different bytes").digest("hex");
  assert.throws(() => verifyAttestationBundle(makeBundle(otherDigest), { repo, digestHex }), /different file/);
});

test("verifyAttestationBundle refuses a certificate naming a different repository", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: "https://github.com/someone-else/Fork/.github/workflows/release.yml@refs/heads/main" });
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /does not name this repository/);
});

test("verifyAttestationBundle accepts only this repository's release workflow run for a final version tag", () => {
  // A self-signed certificate can name anything; before this, any address under the repository
  // passed as a prefix. Only package.yml at refs/tags/v<major>.<minor>.<patch> is accepted now.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  for (const uri of [
    `https://github.com/${repo}/anything`,
    `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v0.3.0`,
    `https://github.com/${repo}/.github/workflows/package.yml@refs/heads/main`,
    `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.3.0-beta.1`,
    `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.3.0/extra`,
    `https://github.com/${repo}-fork/.github/workflows/package.yml@refs/tags/v0.3.0`,
    "https://dotcom.releases.github.com",
    `https://evil.example/URI:https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.3.0`,
  ]) assert.throws(() => verifyAttestationBundle(makeBundle(digestHex, { uri }), { repo, digestHex }),
    /does not name this repository's release workflow for a version tag/, uri);
  for (const uri of [workflowUri, `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v12.0.1+build.7`])
    assert.equal(verifyAttestationBundle(makeBundle(digestHex, { uri }), { repo, digestHex }).workflow, uri);
});

test("a final release accepts only the record made for its own tag, never another version's", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex); // package.yml@refs/tags/v0.3.0
  assert.equal(verifyAttestationBundle(bundle, { repo, digestHex, version: "0.3.0" }).workflow, workflowUri);
  for (const version of ["0.4.0", "0.3.1", "10.3.0", "0.3.0+build.1", "0.0.0-rehearsal.3"])
    assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex, version }),
      /does not name this repository's release workflow for a version tag/, version);
  const built = `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v12.0.1+build.7`;
  assert.equal(verifyAttestationBundle(makeBundle(digestHex, { uri: built }), { repo, digestHex, version: "12.0.1+build.7" }).workflow, built);
  const rehearsal = `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.0.0-rehearsal.3`;
  assert.throws(() => verifyAttestationBundle(makeBundle(digestHex, { uri: rehearsal }), { repo, digestHex, version: "0.0.0-rehearsal.3" }),
    /does not name this repository's release workflow for a version tag/, "a rehearsal's record is never a release's");
});

test("verifyAttestationBundle accepts beta.yml at refs/heads/mac/cross-platform for a Beta version", () => {
  // Beta versions (e.g. "0.19.4-beta.5") accept the beta workflow; final versions (e.g. "0.19.4") do not.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const betaUri = `https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`;
  const bundle = makeBundle(digestHex, { uri: betaUri });
  const result = verifyAttestationBundle(bundle, { repo, digestHex, version: "0.19.4-beta.5" });
  assert.equal(result.workflow, betaUri);
});

test("verifyAttestationBundle refuses beta.yml@refs/heads/mac/cross-platform for a final version", () => {
  // Final versions must accept only package.yml@refs/tags/vX.Y.Z, not the beta workflow.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const betaUri = `https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`;
  const bundle = makeBundle(digestHex, { uri: betaUri });
  assert.throws(
    () => verifyAttestationBundle(bundle, { repo, digestHex, version: "0.19.4" }),
    /does not name this repository's release workflow for a version tag/
  );
});

test("verifyAttestationBundle refuses beta.yml with a different branch or other workflows for Beta versions", () => {
  // Beta versions accept only beta.yml@refs/heads/mac/cross-platform, not variations.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const betaVersion = "0.19.4-beta.5";
  for (const uri of [
    `https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform-dev`,
    `https://github.com/${repo}/.github/workflows/other.yml@refs/heads/mac/cross-platform`,
    `https://github.com/${repo}/.github/workflows/beta.yml@refs/tags/v0.19.4-beta.5`, // tags instead of heads
  ]) {
    const bundle = makeBundle(digestHex, { uri });
    assert.throws(
      () => verifyAttestationBundle(bundle, { repo, digestHex, version: betaVersion }),
      /does not name this repository's release workflow for a version tag/,
      uri
    );
  }
});

test("isBuildProvenance is true for SLSA build provenance only, not GitHub's release attestation", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  assert.equal(isBuildProvenance(makeBundle(digestHex)), true);
  assert.equal(isBuildProvenance(makeBundle(digestHex, { predicateType: "https://slsa.dev/provenance/v0.2" })), true);
  assert.equal(isBuildProvenance(makeReleaseAttestation(digestHex)), false);
  const unreadable = makeBundle(digestHex);
  unreadable.dsseEnvelope.payload = Buffer.from("not json").toString("base64");
  assert.equal(isBuildProvenance(unreadable), false);
});

test("verifyAttestationBundle refuses a tampered signature", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const sig = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, "base64");
  sig[sig.length - 1] ^= 0xff; // flip a bit in the signature itself
  bundle.dsseEnvelope.signatures[0].sig = sig.toString("base64");
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /signature does not check out/);
});

test("verifyAttestationBundle accepts a certificate that has since expired, as long as it was valid when the log says it signed", () => {
  // Fulcio certificates are only ever valid for about ten minutes; every real, months-old release
  // is checked long after its certificate's window has passed. What must hold is that the window
  // covered the moment in the transparency log, not that it still covers right now.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, {
    notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z"),
    integratedTime: Math.floor(new Date("2026-01-01T00:05:00Z").getTime() / 1000),
  });
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("verifyAttestationBundle refuses a certificate that was not valid at the log's signing time", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, {
    notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z"),
    integratedTime: Math.floor(new Date("2026-01-02T00:00:00Z").getTime() / 1000), // a day after the window closed
  });
  assert.throws(() => verifyAttestationBundle(bundle, { repo, digestHex }), /not valid when it was signed/);
});

test("verifyAttestationBundle skips the window check when the bundle carries no signing time", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2026-01-01T00:10:00Z") });
  delete bundle.verificationMaterial.tlogEntries;
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("fetchAttestationBundles treats a 404 as no published record, not an error", async () => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin), init),
      repo, digestHex: "a".repeat(64), userAgent: "test",
    });
    assert.equal(result, null);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles reads a real GitHub-shaped response", async () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const server = createServer((req, res) => {
    assert.equal(req.url, `/repos/${repo}/attestations/sha256:${digestHex}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ attestations: [{ bundle }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { bundles: [read], unreadable } = await fetchAttestationBundles({
      fetch: (url, init) => fetch(url.replace("https://api.github.com", origin), init),
      repo, digestHex, userAgent: "test",
    });
    assert.equal(unreadable, 0);
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles follows bundle_url when GitHub externalises the bundle", async () => {
  // GitHub's own API answers some attestations this way (`bundle: null`, `bundle_url` set) rather
  // than inline — confirmed against `GET /repos/cli/cli/attestations/<digest>` on a real release.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${blobHost}/blob/one` }] }));
    }
    if (req.url === "/blob/one") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(bundle)); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const { bundles: [read] } = await fetchAttestationBundles({ fetch: viaLocal(origin), repo, digestHex, userAgent: "test" });
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

/**
 * A from-scratch, general-purpose raw-Snappy-block encoder, test-only, with no dependency: the
 * inverse of `decodeSnappy` in `src/desktop/provenance.ts`. It greedily backreferences any repeat of
 * 4+ bytes anywhere earlier in the buffer (a real LZ77 match, not a stub), so encoding real bundle
 * JSON — which repeats punctuation, field names and base64 runs throughout — exercises the copy-op
 * path the decoder must handle, the same shape GitHub's blob storage actually serves
 * (`Content-Type: application/x-snappy`, confirmed live against `repos/cli/cli/attestations/...`).
 * Prefers the 1-byte-offset copy form (type 1) whenever the match is in range for it — the form
 * GitHub's real stream actually uses (confirmed: byte offset 0x48 of a live cli/cli bundle is tag
 * `0x09`, a type-1 copy) — and falls back to the 2-byte-offset form (type 2) only when the offset is
 * too far for type 1. Returns `{ encoded, usedCopyType1, usedCopyType2 }` so a test can assert it
 * exercised both copy forms `decodeSnappy` supports, not just literals.
 */
function snappyEncodeForTest(buf) {
  const chunks = [];
  let n = buf.length;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; chunks.push(Buffer.from([b])); } while (n);
  let usedCopyType1 = false, usedCopyType2 = false;
  let i = 0;
  while (i < buf.length) {
    let bestLen = 0, bestOff = 0;
    const maxOffset = Math.min(i, 65535);
    for (let off = 4; off <= maxOffset; off++) {
      let l = 0;
      const cap = Math.min(64, buf.length - i);
      while (l < cap && buf[i - off + l] === buf[i + l]) l++;
      if (l > bestLen) { bestLen = l; bestOff = off; }
    }
    if (bestLen >= 4) {
      if (bestLen <= 11 && bestOff <= 2047) {
        usedCopyType1 = true;
        const tag = (((bestOff >> 8) & 0x7) << 5) | ((bestLen - 4) << 2) | 0x01;
        chunks.push(Buffer.from([tag, bestOff & 0xff]));
      } else {
        usedCopyType2 = true;
        chunks.push(Buffer.from([((bestLen - 1) << 2) | 0x02, bestOff & 0xff, (bestOff >> 8) & 0xff]));
      }
      i += bestLen;
    } else {
      chunks.push(Buffer.from([0x00]), buf.subarray(i, i + 1)); // literal, length 1
      i += 1;
    }
  }
  return { encoded: Buffer.concat(chunks), usedCopyType1, usedCopyType2 };
}

test("fetchAttestationBundles reads a bundle_url served as raw Snappy (as GitHub's blob storage does)", async () => {
  // Confirmed live: `gh api repos/cli/cli/attestations/sha256:<digest>` answers `bundle_url` pointing
  // at an Azure blob whose response has `Content-Type: application/x-snappy` and whose bytes are the
  // raw Snappy block format (varint length, then literal/copy elements) — not gzip, not framed.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const bundleJson = Buffer.from(JSON.stringify(bundle), "utf8");
  const { encoded, usedCopyType1, usedCopyType2 } = snappyEncodeForTest(bundleJson);
  assert.ok(usedCopyType1, "the fixture should exercise the 1-byte-offset copy form, the one GitHub's real stream uses");
  assert.ok(usedCopyType2, "the fixture should also exercise the 2-byte-offset copy form");
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${blobHost}/blob/one.json.sn?sv=2020&sig=x` }] }));
    }
    if (req.url === "/blob/one.json.sn?sv=2020&sig=x") { res.writeHead(200, { "content-type": "application/x-snappy" }); return res.end(encoded); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const { bundles: [read] } = await fetchAttestationBundles({ fetch: viaLocal(origin), repo, digestHex, userAgent: "test" });
    const result = verifyAttestationBundle(read, { repo, digestHex });
    assert.equal(result.workflow, workflowUri);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles counts a bundle_url it cannot read as JSON or Snappy as unreadable, rather than failing the update", async () => {
  // These 6 bytes are a truncated raw-Snappy stream (a valid varint length and literal tag, but the
  // literal itself cut short) — not plain JSON, and not a Snappy body `decodeSnappy` can finish
  // reading either. That combination is treated the same as no bundle at all — quietly skipped,
  // never thrown — never something that could block an update.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const server = createServer((req, res) => {
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${blobHost}/blob/one` }] }));
    }
    if (req.url === "/blob/one") { res.writeHead(200); return res.end(Buffer.from([0x84, 0x32, 0xf0, 0x43, 0x7b, 0x22])); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetchAttestationBundles({ fetch: viaLocal(origin), repo, digestHex, userAgent: "test" });
    assert.deepEqual(result, { bundles: [], unreadable: 1 });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("fetchAttestationBundles treats a bundle_url that answers with a redirect as unreadable, never following it", async (t) => {
  // A redirect on a bundle_url is not followed — `redirect: "error"` in fetchExternalBundle
  // rejects the response. The redirect target is never fetched, and the bundle counts as unreadable.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const visited = [];
  const server = createServer((req, res) => {
    visited.push(req.url);
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: [{ bundle: null, bundle_url: `${blobHost}/blob/redirect` }] }));
    }
    if (req.url === "/blob/redirect") { res.writeHead(302, { location: `/blob/valid` }); return res.end(); }
    if (req.url === "/blob/valid") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(bundle)); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    const result = await fetchAttestationBundles({ fetch: viaLocal(origin), repo, digestHex, userAgent: "test" });
    assert.deepEqual(result, { bundles: [], unreadable: 1 });
    assert.ok(visited.includes("/blob/redirect"), "the redirect URL was visited");
    assert.ok(!visited.includes("/blob/valid"), "the redirect target was never visited");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

/** A local server answering the attestations address with `entries`, and `blobs` (path → handler) for bundle_url bodies. */
async function attestationServer(t, digestHex, entries, blobs = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === `/repos/${repo}/attestations/sha256:${digestHex}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: entries }));
    }
    if (blobs[req.url]) return blobs[req.url](res);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  return { origin, hits };
}

test("fetchAttestationBundles follows bundle_url only over https to GitHub's blob host, and counts others unreadable", async (t) => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex);
  const serve = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(bundle)); };
  const refused = [
    "http://127.0.0.1:1/blob/one", // plain http, some other host
    "http://tmaproduction.blob.core.windows.net/blob/one", // the right host, but not https
    "https://attacker.blob.core.windows.net/blob/one", // another Azure customer's storage
    "https://tmaproduction.blob.core.windows.net.example.com/blob/one",
    "https://tmaproduction.blob.core.windows.net:8443/blob/one",
  ];
  const fixture = await attestationServer(t, digestHex, refused.map((bundle_url) => ({ bundle: null, bundle_url })), { "/blob/one": serve });
  const followed = [];
  const result = await fetchAttestationBundles({
    fetch: (url, init) => {
      if (!url.startsWith("https://api.github.com")) followed.push(url);
      return fetch(url.replace(/^https?:\/\/[^/]+/, fixture.origin()), init);
    },
    repo, digestHex, userAgent: "test",
  });
  assert.deepEqual(followed, [], "none of those addresses was fetched");
  assert.deepEqual(result, { bundles: [], unreadable: refused.length });
});

test("fetchAttestationBundles stops reading a bundle_url body past its size cap", async (t) => {
  // A real bundle padded with trailing spaces to 5 MiB, sent in chunks with no content-length:
  // still valid JSON, so only a cap on the bytes read keeps it from being taken in whole.
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const json = Buffer.from(JSON.stringify(makeBundle(digestHex)), "utf8");
  const serve = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(json);
    const pad = Buffer.alloc(64 * 1024, 0x20);
    for (let sent = json.length; sent < 5 * 1024 * 1024; sent += pad.length) res.write(pad);
    res.end();
  };
  const fixture = await attestationServer(t, digestHex, [{ bundle: null, bundle_url: `${blobHost}/blob/big` }], { "/blob/big": serve });
  const result = await fetchAttestationBundles({ fetch: viaLocal(fixture.origin), repo, digestHex, userAgent: "test" });
  assert.deepEqual(result, { bundles: [], unreadable: 1 });
});

test("fetchAttestationBundles throws on a rate-limit answer so the updater can say the record was not checked", async (t) => {
  const server = createServer((_req, res) => { res.writeHead(403, { "x-ratelimit-remaining": "0" }); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(fetchAttestationBundles({ fetch: viaLocal(origin), repo, digestHex: "a".repeat(64), userAgent: "test" }), /HTTP 403/);
});

/**
 * A full download-through-install fixture, the same shape `tests/updater.test.mjs` uses, with more
 * routes: the attestations GitHub would serve at install time, and bundle_url bodies on its blob
 * host. `attestationFor` receives the archive's own digest (only known once it is built) and returns
 * null (no record published, today's reality for every release), `{ status }` for an answer other
 * than 200, a bundle, or a list of attestation entries (`{ bundle }` or `{ bundle_url }`).
 */
async function installFixture(t, { attestationFor = () => null, blobs = {}, realArchive = windows, tag = "v0.3.0" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-provenance-"));
  t.after(() => discardTemp(root));
  const source = join(root, "Branch Agent-win32-x64");
  await mkdir(join(source, "resources", "app"), { recursive: true });
  await writeFile(join(source, "Branch Agent Test.exe"), "new executable");
  await writeFile(join(source, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "0.3.0" }));
  const archive = join(root, "Branch-Agent-windows-x64.zip");
  if (realArchive)
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -LiteralPath '${source}' -DestinationPath '${archive}' -Force`]);
  else await writeFile(archive, "not a real archive");
  const bytes = await readFile(archive);
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  const attestation = attestationFor(digestHex);
  let attestationHits = 0;
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/repos/stabrea/Branch-Agent/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        tag_name: tag, name: `Branch Agent ${tag}`, body: "Notes", published_at: "2026-09-15T00:00:00Z",
        html_url: `https://github.com/stabrea/Branch-Agent/releases/tag/${tag}`,
        assets: [
          { name: "Branch-Agent-windows-x64.zip", browser_download_url: `${origin()}/download/app.zip`, size: bytes.length },
          { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `${origin()}/download/app.sha256`, size: 96 },
        ],
      }));
    }
    if (req.url === "/download/app.zip") { res.writeHead(200, { "content-length": bytes.length }); return res.end(bytes); }
    if (req.url === "/download/app.sha256") { res.writeHead(200); return res.end(`${digestHex}  Branch-Agent-windows-x64.zip\n`); }
    if (req.url === `/repos/stabrea/Branch-Agent/attestations/sha256:${digestHex}`) {
      attestationHits += 1;
      if (!attestation) { res.writeHead(404); return res.end(); }
      if (attestation.status) { res.writeHead(attestation.status); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ attestations: Array.isArray(attestation) ? attestation : [{ bundle: attestation }] }));
    }
    if (blobs[req.url]) return blobs[req.url](res);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const fetchViaFixture = viaLocal(origin);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent Test.exe"), "old executable");
  const downloads = () => hits.filter((url) => url === "/download/app.zip").length;
  return { root, installDir, fetchViaFixture, digestHex, hits, attestationHits: () => attestationHits, downloads };
}

/**
 * An updater for `fixture` whose unpack step is replaced by one that stops the install with
 * `reachedUnpack`: everything up to and including the provenance check runs for real, on every
 * operating system, and reaching the unpack step is the proof the check let the update through.
 */
const reachedUnpack = "reached the unpack step";
function gateUpdater(fixture, { platform = "win32", fetch = fixture.fetchViaFixture, repo = "stabrea/Branch-Agent" } = {}) {
  return new Updater({
    repo, currentVersion: "0.2.0", installDir: fixture.installDir, platform,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch,
    extract: async () => { throw new Error(reachedUnpack); },
  });
}
/** Runs an install that the provenance check must let through; returns the outcome it recorded. */
async function outcomeLettingThrough(fixture, options) {
  const updater = gateUpdater(fixture, options);
  await assert.rejects(updater.install(), new RegExp(reachedUnpack));
  return updater.status.provenance;
}

test("install proceeds on the checksum alone when no provenance record is published", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const fixture = await installFixture(t);
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: fixture.installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch: fixture.fetchViaFixture,
  });
  const { script } = await updater.install();
  assert.ok(script);
  assert.equal(fixture.attestationHits(), 1, "the updater asked GitHub for a provenance record");
  assert.equal(updater.status.provenance.outcome, "none");
});

test("install checks a real provenance record and says what was checked", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const fixture = await installFixture(t, { attestationFor: (digestHex) => makeBundle(digestHex) });
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: fixture.installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(fixture.root, "scratch"), fetch: fixture.fetchViaFixture,
  });
  const { script } = await updater.install();
  assert.ok(script);
  assert.equal(fixture.attestationHits(), 1);
  assert.deepEqual(updater.status.provenance, { outcome: "checked", message: PROVENANCE_WORDS.checked });
});

test("install refuses a provenance record for a different file, and removes what was downloaded, on every system", async (t) => {
  // The refusal happens before anything is unpacked, so it is tested the same way everywhere.
  for (const platform of ["win32", "linux", "darwin"]) {
    const fixture = await installFixture(t, {
      realArchive: false,
      attestationFor: () => makeBundle(createHash("sha256").update("some other file entirely").digest("hex")),
    });
    const updater = gateUpdater(fixture, { platform });
    await assert.rejects(updater.install(), /provenance record did not check out/, platform);
    await assert.rejects(readFile(join(fixture.root, "scratch", "Branch-Agent-windows-x64.zip")), /ENOENT/);
  }
});

/* Before the move a copy set to KeepOak finds the release under stabrea (KeepOak answers 404). The provenance
   record is asked of the repository that served the release, so a bad one is found and stops the update; asked
   of KeepOak, there would be no record at all and the update would go on with the checksum alone. */
test("a release found under the old name has its provenance record asked of the old name, and a bad one stops it", async (t) => {
  const fixture = await installFixture(t, {
    realArchive: false, attestationFor: () => makeBundle(createHash("sha256").update("some other file entirely").digest("hex")),
  });
  await assert.rejects(gateUpdater(fixture, { repo: "KeepOak/Branch-Agent" }).install(), /provenance record did not check out \(the provenance record is for a different file\)/);
  assert.equal(fixture.attestationHits(), 1, "the record was asked of stabrea/Branch-Agent, which served the release");
  assert.ok(fixture.hits.includes("/repos/KeepOak/Branch-Agent/releases/latest"), "the new name was asked first");
});

test("install refuses a self-signed record naming anything but the release workflow for a version tag", async (t) => {
  const fixture = await installFixture(t, {
    realArchive: false, attestationFor: (digestHex) => makeBundle(digestHex, { uri: `https://github.com/${repo}/anything` }),
  });
  await assert.rejects(gateUpdater(fixture).install(), /did not check out \(the provenance record's signing certificate does not name this repository's release workflow/);
});

test("install goes on when GitHub's own release attestation is the only record, counting it as none", async (t) => {
  // With immutable releases on, GitHub serves its release attestation (a different statement type,
  // signed as dotcom.releases.github.com) for every asset. It is not build provenance and must not
  // be held to the workflow check, or every copy would refuse every update.
  const fixture = await installFixture(t, { realArchive: false, attestationFor: (digestHex) => makeReleaseAttestation(digestHex) });
  assert.deepEqual(await outcomeLettingThrough(fixture), { outcome: "none", message: PROVENANCE_WORDS.none });
});

test("install checks the build provenance record next to GitHub's release attestation", async (t) => {
  const fixture = await installFixture(t, {
    realArchive: false,
    attestationFor: (digestHex) => [{ bundle: makeReleaseAttestation(digestHex) }, { bundle: makeBundle(digestHex) }],
  });
  assert.equal((await outcomeLettingThrough(fixture)).outcome, "checked");
});

test("install still refuses a bad build provenance record that sits next to GitHub's release attestation", async (t) => {
  const other = createHash("sha256").update("some other file entirely").digest("hex");
  const fixture = await installFixture(t, {
    realArchive: false,
    attestationFor: (digestHex) => [{ bundle: makeReleaseAttestation(digestHex) }, { bundle: makeBundle(other) }],
  });
  await assert.rejects(gateUpdater(fixture).install(), /provenance record did not check out \(the provenance record is for a different file\)/);
});

test("install says the record was not checked when GitHub answers with a rate limit", async (t) => {
  const fixture = await installFixture(t, { realArchive: false, attestationFor: () => ({ status: 403 }) });
  assert.deepEqual(await outcomeLettingThrough(fixture), { outcome: "not-checked", message: PROVENANCE_WORDS["not-checked"] });
});

test("install says the record was not checked when asking GitHub times out", async (t) => {
  const fixture = await installFixture(t, { realArchive: false, attestationFor: (digestHex) => makeBundle(digestHex) });
  const fetch = (url, init) => url.includes("/attestations/")
    ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
    : fixture.fetchViaFixture(url, init);
  assert.equal((await outcomeLettingThrough(fixture, { fetch })).outcome, "not-checked");
});

test("install says the record was not checked when its bundle_url is too large or on another host", async (t) => {
  const fixture = await installFixture(t, {
    realArchive: false,
    attestationFor: () => [{ bundle: null, bundle_url: `${blobHost}/blob/big` }, { bundle: null, bundle_url: "https://elsewhere.example/blob/one" }],
    blobs: {
      "/blob/big": (res) => {
        res.writeHead(200);
        const pad = Buffer.alloc(64 * 1024, 0x20);
        for (let sent = 0; sent < 5 * 1024 * 1024; sent += pad.length) res.write(pad);
        res.end();
      },
    },
  });
  assert.equal((await outcomeLettingThrough(fixture)).outcome, "not-checked");
});

/* Every release after 0.19.3 is built by package.yml, which records provenance, so from the first of them on the
   record is required: none stops the update, and one GitHub could not be asked about makes it wait, before anything
   is downloaded. 0.19.3 and older keep going on the checksum alone. */
const requiredTag = "v0.20.0";
const requiredUri = `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/${requiredTag}`;
test("the provenance switch turns on by itself for every release after 0.19.3", () => {
  assert.equal(LAST_RELEASE_WITHOUT_PROVENANCE, "0.19.3");
  for (const version of ["0.19.3", "0.19.2", "0.3.0", "0.19.3+build.1"]) assert.equal(provenanceRequired(version), false, version);
  for (const version of ["0.19.4", "0.20.0", "1.0.0"]) assert.equal(provenanceRequired(version), true, version);
});

test("a release after 0.19.3 with no build provenance record is refused before it is downloaded", async (t) => {
  for (const attestationFor of [() => null, (digestHex) => makeReleaseAttestation(digestHex)]) {
    const fixture = await installFixture(t, { realArchive: false, tag: requiredTag, attestationFor });
    const updater = gateUpdater(fixture);
    await assert.rejects(updater.install(), /No build provenance record is published for this download, and every release after 0\.19\.3 has one/);
    assert.equal(fixture.downloads(), 0, "nothing was downloaded");
    assert.equal(updater.status.phase, "error");
  }
});

test("a release after 0.19.3 whose record GitHub cannot be asked about waits, and downloads nothing", async (t) => {
  const fixture = await installFixture(t, { realArchive: false, tag: requiredTag, attestationFor: () => ({ status: 403 }) });
  const updater = gateUpdater(fixture);
  await assert.rejects(updater.install(), (error) => error instanceof UpdateDeferredError && /waits and tries again/.test(error.message));
  assert.equal(fixture.downloads(), 0);
  assert.equal(updater.status.phase, "available", "a wait, not a failure: update by itself looks again");
});

test("a release after 0.19.3 with its own record is checked once, then downloaded", async (t) => {
  const fixture = await installFixture(t, { realArchive: false, tag: requiredTag, attestationFor: (digestHex) => makeBundle(digestHex, { uri: requiredUri }) });
  assert.equal((await outcomeLettingThrough(fixture)).outcome, "checked");
  assert.equal(fixture.attestationHits(), 1, "asked once, before the download");
  assert.equal(fixture.downloads(), 1);
  const other = await installFixture(t, { realArchive: false, tag: requiredTag, attestationFor: (digestHex) => makeBundle(digestHex) });
  await assert.rejects(gateUpdater(other).install(), /did not check out/, "a record made for another version's tag is refused");
  assert.equal(other.downloads(), 0);
});

test("a download that differs from the checksum its record was checked against is still refused", async (t) => {
  const fixture = await installFixture(t, { realArchive: false, tag: requiredTag, attestationFor: (digestHex) => makeBundle(digestHex, { uri: requiredUri }) });
  const fetch = async (url, init) => url.endsWith("/download/app.zip") ? new Response("swapped after the check") : fixture.fetchViaFixture(url, init);
  await assert.rejects(gateUpdater(fixture, { fetch }).install(), /did not match the published checksum/);
});

test("the provenance words say what was checked, admit the chain was not, and are translated", async () => {
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const keys = { checked: "updates.provenance.checked", "not-checked": "updates.provenance.notChecked", none: "updates.provenance.none" };
  for (const [outcome, key] of Object.entries(keys)) {
    assert.equal(PROVENANCE_WORDS[outcome], english[key], `${outcome} words are the ones the language file holds`);
    assert.ok(french[key] && french[key] !== english[key], `${key} has French words`);
    assert.doesNotMatch(PROVENANCE_WORDS[outcome], /checks out/);
  }
  assert.match(PROVENANCE_WORDS.checked, /release workflow/);
  assert.match(PROVENANCE_WORDS.checked, /chain back to Sigstore was not verified/);
  assert.match(french[keys.checked], /n'a pas été vérifiée/);
  assert.match(PROVENANCE_WORDS["not-checked"], /was not checked/);
});

test("verifyAttestationBundle accepts beta.yml for a Beta version only, rejects package.yml for Beta, and rejects beta.yml for final versions", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  // Beta version accepts beta.yml@refs/heads/mac/cross-platform
  const betaUri = `https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`;
  const betaBundle = makeBundle(digestHex, { uri: betaUri });
  assert.equal(
    verifyAttestationBundle(betaBundle, { repo, digestHex, version: "0.19.4-beta.5" }).workflow,
    betaUri,
    "Beta version accepts beta.yml@refs/heads/mac/cross-platform"
  );
  // Final version refuses beta.yml
  assert.throws(
    () => verifyAttestationBundle(betaBundle, { repo, digestHex, version: "0.19.4" }),
    /does not name this repository's release workflow for a version tag/,
    "final version refuses beta.yml"
  );
  // Beta version refuses package.yml
  const packageUri = `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.19.4-beta.5`;
  const packageBundle = makeBundle(digestHex, { uri: packageUri });
  assert.throws(
    () => verifyAttestationBundle(packageBundle, { repo, digestHex, version: "0.19.4-beta.5" }),
    /does not name this repository's release workflow for a version tag/,
    "Beta version refuses package.yml"
  );
});

test("a retried install clears the previous attempt's provenance outcome", { skip: !windows && "Windows archive tooling" }, async (t) => {
  // Attempt 1: records "checked" and then fails at the stubbed extract.
  const fixture = await installFixture(t, { attestationFor: (d) => makeBundle(d) });
  let digestAttempt1 = null;
  const fetchWrapped = async (url, init) => {
    const response = await fixture.fetchViaFixture(url, init);
    if (url.endsWith(".sha256")) {
      if (!digestAttempt1) {
        // Capture the real digest on first attempt
        digestAttempt1 = (await response.clone().text()).split(/\s+/)[0];
      } else if (response.status === 200) {
        // On second attempt, return a wrong digest so checksum fails
        const wrongDigest = "a".repeat(64);
        return new Response(`${wrongDigest}  Branch-Agent-windows-x64.zip\n`, { status: 200 });
      }
    }
    return response;
  };
  const updater1 = gateUpdater(fixture, { fetch: fetchWrapped });
  await assert.rejects(updater1.install(), new RegExp(reachedUnpack));
  assert.equal(updater1.status.provenance?.outcome, "checked", "attempt 1 recorded checked");

  // Attempt 2: uses the same updater, which fails before the provenance check (bad checksum).
  await assert.rejects(updater1.install(), /did not match the published checksum/);
  // The provenance from attempt 1 should not appear in attempt 2's status.
  assert.equal(updater1.status.provenance, undefined, "attempt 2 clears the old provenance");
});

// Mac mini review 2 (sprint rule 1): the Beta ruling and the Q74 wiring, each through something that
// goes red when it is undone.
const betaWorkflow = `https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`;

test("a Beta version refuses package.yml even at a real final tag, and every look-alike of the Beta workflow", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  for (const uri of [
    `https://github.com/${repo}/.github/workflows/package.yml@refs/tags/v0.19.3`,
    `https://github.com/someone/Branch-Agent/.github/workflows/beta.yml@refs/heads/mac/cross-platform`,
    `https://github.com/${repo}-fork/.github/workflows/beta.yml@refs/heads/mac/cross-platform`,
    `https://github.com/${repo}/.github/workflows/beta.yml@refs/tags/mac/cross-platform`,
    `https://evil.example/URI:https://github.com/${repo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`,
  ]) assert.throws(() => verifyAttestationBundle(makeBundle(digestHex, { uri }), { repo, digestHex, version: "0.19.4-beta.5" }),
    /does not name this repository's release workflow/, uri);
});

/* Beta is built on this computer and never downloaded (src/desktop/dev-build.ts), so no Beta install reads a
   provenance record; the beta workflow checks above stay with src/desktop/provenance.ts. */

// Repo-move tests: both stabrea and KeepOak are trusted repos.
const keepOakRepo = "KeepOak/Branch-Agent";
const keepOakWorkflow = `https://github.com/${keepOakRepo}/.github/workflows/package.yml@refs/tags/v0.3.0`;
const keepOakBetaWorkflow = `https://github.com/${keepOakRepo}/.github/workflows/beta.yml@refs/heads/mac/cross-platform`;

test("verifyAttestationBundle accepts KeepOak's release workflow for a final version", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: keepOakWorkflow });
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, keepOakWorkflow);
});

test("verifyAttestationBundle accepts stabrea's release workflow for a final version", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: workflowUri });
  const result = verifyAttestationBundle(bundle, { repo, digestHex });
  assert.equal(result.workflow, workflowUri);
});

test("verifyAttestationBundle accepts KeepOak's beta workflow for a Beta version", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: keepOakBetaWorkflow });
  const result = verifyAttestationBundle(bundle, { repo, digestHex, version: "0.19.4-beta.5" });
  assert.equal(result.workflow, keepOakBetaWorkflow);
});

test("verifyAttestationBundle refuses KeepOak's beta.yml for a final version", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const bundle = makeBundle(digestHex, { uri: keepOakBetaWorkflow });
  assert.throws(
    () => verifyAttestationBundle(bundle, { repo, digestHex, version: "0.19.4" }),
    /does not name this repository's release workflow for a version tag/
  );
});

test("verifyAttestationBundle refuses look-alike repos (KeepOak-x, keepoak lowercase, etc.)", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const lookAlikes = [
    "KeepOak-x",
    "KeepOakx",
    "keepoak",
    "KEEPOAK",
    "keepoak.evil",
    "KeepOak/Branch-Agent-fork",
    "someone/Branch-Agent",
    // Whole names that differ from Branch's two only in case or in the owner.
    "keepoak/Branch-Agent",
    "KeepOak/branch-agent",
    "Stabrea/Branch-Agent",
    "stabrea/branch-agent",
    "KeepOak-x/Branch-Agent",
  ];
  for (const lookAlike of lookAlikes) {
    const fakeUri = `https://github.com/${lookAlike}/.github/workflows/package.yml@refs/tags/v0.3.0`;
    const bundle = makeBundle(digestHex, { uri: fakeUri });
    assert.throws(
      () => verifyAttestationBundle(bundle, { repo, digestHex }),
      /does not name this repository's release workflow for a version tag/,
      lookAlike
    );
  }
});

test("verifyAttestationBundle refuses evil domains that look like the URI", () => {
  const digestHex = createHash("sha256").update("archive bytes").digest("hex");
  const evilUri = `https://evil.example/URI:https://github.com/${keepOakRepo}/.github/workflows/package.yml@refs/tags/v0.3.0`;
  const bundle = makeBundle(digestHex, { uri: evilUri });
  assert.throws(
    () => verifyAttestationBundle(bundle, { repo, digestHex }),
    /does not name this repository's release workflow for a version tag/
  );
});
