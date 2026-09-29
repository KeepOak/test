import { createVerify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { TRUSTED_REPOS } from "./repo-pair.js";

/**
 * Build provenance for an update, on top of the SHA-256 match (`Updater`'s own `verify`) and the
 * package identity check (`validateStagedPackage`): whether a build-provenance record GitHub has
 * published for the downloaded file is about this exact file, is signed by the certificate that came
 * with it, and names Branch's own release workflow (`.github/workflows/package.yml`) run for a
 * version tag.
 *
 * GitHub publishes such a record only once a release workflow asks for one (the
 * `actions/attest-build-provenance` step); Branch's own workflow does not yet, so most releases
 * have none to check. That is answered as "nothing to check", not as a failure: this record adds
 * to the checksum, it does not replace it, so its absence never blocks an update the checksum
 * already passed. A build-provenance record that is present and fails these checks does block the
 * update, the same way a checksum that does not match already does.
 *
 * Only SLSA build-provenance statements (`isBuildProvenance`) are checked. GitHub answers the same
 * address with other kinds of record too: with immutable releases on, it adds its own release
 * attestation (`https://in-toto.io/attestation/release/v0.2`, signed as
 * `https://dotcom.releases.github.com`, not as a workflow). That is not a build-provenance record, so
 * it counts as no record rather than as one that failed.
 *
 * What this does not do: walk the signing certificate up to Sigstore's own root of trust (Fulcio's
 * CA) or check its inclusion in the Rekor transparency log. Both need the `sigstore` package, a new
 * dependency this change does not add. So the certificate's own claims (which workflow, which ref)
 * are only as trustworthy as GitHub's API, reached over TLS, and the words Branch shows say that the
 * certificate chain was not verified.
 *
 * GitHub sometimes answers with `bundle_url` (a separate blob address) instead of an inline
 * `bundle`; checked against a real, currently-published release (`gh api
 * repos/cli/cli/attestations/sha256:<digest>`), that URL is on `tmaproduction.blob.core.windows.net`
 * and serves `Content-Type: application/x-snappy` (the address itself ends `.json.sn`) — the raw
 * Snappy block format (a varint uncompressed length, then literal/copy elements; RFC-less but
 * documented at github.com/google/snappy/blob/main/format_description.txt), not a framed stream and
 * not gzip. `decodeSnappy` below reads that shape with no dependency. Only that host, over https, is
 * followed, and no body is read past `MAX_BODY_BYTES`. A bundle that cannot be fetched or read is
 * counted as unreadable, which the updater reports as "provenance not checked" — never trusted
 * half-read, and never allowed to block an update the checksum already passed.
 */

/**
 * Decodes the raw Snappy block format (no framing, no CRC): a varint uncompressed length followed by
 * literal and copy elements. Bounds-checked throughout — a malformed or hostile stream (this reads
 * network input) throws rather than over-reading, and every caller treats that throw as "unreadable",
 * the same as bytes that were never Snappy to begin with.
 */
function decodeSnappy(input: Buffer, maxLength = 8 * 1024 * 1024): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0, shift = 0;
    for (;;) {
      if (pos >= input.length) throw new Error("truncated snappy varint");
      const byte = input[pos]!; pos++;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new Error("snappy varint too long");
    }
    return result >>> 0;
  };
  const uncompressedLength = readVarint();
  if (uncompressedLength > maxLength) throw new Error("snappy uncompressed length too large");
  const out = Buffer.alloc(uncompressedLength);
  let written = 0;
  while (pos < input.length) {
    const tag = input[pos]!;
    const elementType = tag & 0x3;
    if (elementType === 0) {
      let length = (tag >>> 2) + 1;
      pos++;
      if (length > 60) {
        const extraBytes = length - 60;
        if (pos + extraBytes > input.length) throw new Error("truncated snappy literal length");
        let n = 0;
        for (let i = 0; i < extraBytes; i++) n |= input[pos + i]! << (8 * i);
        pos += extraBytes;
        length = (n >>> 0) + 1;
      }
      if (pos + length > input.length) throw new Error("truncated snappy literal");
      if (written + length > out.length) throw new Error("snappy literal overruns declared length");
      input.copy(out, written, pos, pos + length);
      written += length; pos += length;
    } else {
      let length: number, offset: number;
      if (elementType === 1) {
        length = ((tag >>> 2) & 0x7) + 4;
        if (pos + 1 >= input.length) throw new Error("truncated snappy copy");
        offset = ((tag & 0xe0) << 3) | input[pos + 1]!;
        pos += 2;
      } else if (elementType === 2) {
        length = (tag >>> 2) + 1;
        if (pos + 2 >= input.length) throw new Error("truncated snappy copy");
        offset = input.readUInt16LE(pos + 1);
        pos += 3;
      } else {
        length = (tag >>> 2) + 1;
        if (pos + 4 >= input.length) throw new Error("truncated snappy copy");
        offset = input.readUInt32LE(pos + 1);
        pos += 5;
      }
      if (offset === 0 || offset > written) throw new Error("snappy copy offset out of range");
      if (written + length > out.length) throw new Error("snappy copy overruns declared length");
      // Byte-by-byte on purpose: Snappy copies may overlap their own not-yet-finished source run.
      for (let i = 0; i < length; i++) out[written + i] = out[written - offset + i]!;
      written += length;
    }
  }
  if (written !== uncompressedLength) throw new Error("snappy stream shorter than its declared length");
  return out;
}

const certSchema = z.object({ rawBytes: z.string().min(1) });
const bundleSchema = z.object({
  dsseEnvelope: z.object({
    payload: z.string().min(1),
    payloadType: z.string().min(1),
    signatures: z.array(z.object({ sig: z.string().min(1), keyid: z.string().optional() })).min(1),
  }),
  verificationMaterial: z.object({
    certificate: certSchema.optional(),
    x509CertificateChain: z.object({ certificates: z.array(certSchema).min(1) }).optional(),
    /** The Rekor entry the bundle was logged under; its time is what the signing certificate's short validity window is checked against, not the moment Branch happens to check. */
    tlogEntries: z.array(z.object({ integratedTime: z.union([z.string(), z.number()]).optional() })).optional(),
  }),
});
export type AttestationBundle = z.infer<typeof bundleSchema>;
/** A bundle GitHub answered with directly, or only a URL to fetch it from (GitHub externalises some). */
const attestationEntrySchema = z.object({ bundle: bundleSchema.nullable().optional(), bundle_url: z.string().url().optional() });
const attestationsResponseSchema = z.object({ attestations: z.array(attestationEntrySchema) });

const inTotoStatementSchema = z.object({
  subject: z.array(z.object({ digest: z.object({ sha256: z.string().optional() }).partial() })).min(1),
});

/** The SLSA build-provenance statement types; any other in-toto statement is some other kind of record. */
const BUILD_PROVENANCE_TYPES = new Set(["https://slsa.dev/provenance/v1", "https://slsa.dev/provenance/v0.2"]);

/** True when a bundle's statement is an SLSA build-provenance record (see the file-level comment). */
export function isBuildProvenance(bundle: AttestationBundle): boolean {
  try {
    const statement: unknown = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    const type = (statement as { predicateType?: unknown } | null)?.predicateType;
    return typeof type === "string" && BUILD_PROVENANCE_TYPES.has(type);
  } catch { return false; }
}

/** The only place GitHub has been seen to keep externalised bundles; anything else is not followed. */
const BUNDLE_HOSTS = new Set(["tmaproduction.blob.core.windows.net"]);
/** A real bundle is a few kilobytes; nothing larger than this is read from the network. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Reads a response body, refusing (and cancelling) one larger than `MAX_BODY_BYTES`. */
async function readCapped(response: Response): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("response too large");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("response too large"); }
    parts.push(part.value);
  }
  return Buffer.concat(parts);
}

/** Every record GitHub returned that could be read, and how many could not be fetched or read. */
export interface AttestationLookup { bundles: AttestationBundle[]; unreadable: number }

/**
 * Fetches every attestation GitHub has published for this file's SHA-256, or null when it has none.
 * Throws when GitHub cannot be reached or does not answer 200/404 (a rate limit, a timeout), which
 * the updater reports as "provenance not checked". An externalised bundle that cannot be fetched or
 * read is counted in `unreadable`, never trusted and never thrown.
 */
export async function fetchAttestationBundles(input: {
  fetch: typeof fetch; repo: string; digestHex: string; userAgent: string;
}): Promise<AttestationLookup | null> {
  const response = await input.fetch(`https://api.github.com/repos/${input.repo}/attestations/sha256:${input.digestHex}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": input.userAgent },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub did not answer about the build provenance record for this download (HTTP ${response.status}).`);
  const parsed = attestationsResponseSchema.safeParse(JSON.parse((await readCapped(response)).toString("utf8")));
  if (!parsed.success || parsed.data.attestations.length === 0) return null;
  const lookup: AttestationLookup = { bundles: [], unreadable: 0 };
  for (const entry of parsed.data.attestations) {
    if (entry.bundle) { lookup.bundles.push(entry.bundle); continue; }
    const fetched = entry.bundle_url ? await fetchExternalBundle(input.fetch, entry.bundle_url, input.userAgent) : null;
    if (fetched) lookup.bundles.push(fetched); else lookup.unreadable++;
  }
  return lookup;
}

/**
 * A bundle GitHub externalised, fetched only from `BUNDLE_HOSTS` over https: read as plain JSON
 * first, and, when that is not what the body is, as JSON inside a raw-Snappy-compressed body — null,
 * never thrown, when it cannot be fetched or neither reading gives valid JSON of this shape.
 */
async function fetchExternalBundle(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<AttestationBundle | null> {
  try {
    const address = new URL(url);
    if (address.protocol !== "https:" || !BUNDLE_HOSTS.has(address.hostname) || address.port) return null;
    const response = await fetchImpl(address.href, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) return null;
    const bytes = await readCapped(response);
    let json: unknown;
    try { json = JSON.parse(bytes.toString("utf8")); }
    catch {
      try { json = JSON.parse(decodeSnappy(bytes).toString("utf8")); }
      catch { return null; }
    }
    const parsed = bundleSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** DSSE's Pre-Authentication Encoding: the exact bytes a bundle's signature is taken over. */
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"), type,
    Buffer.from(` ${payload.length} `, "utf8"), payload,
  ]);
}

export interface ProvenanceExpectation {
  /** "owner/name" — the repository the release belongs to. */
  repo: string;
  /** The downloaded archive's own SHA-256, already checked against the published checksum. */
  digestHex: string;
  /** The release version being installed (e.g. "0.19.4-beta.5" or "0.19.4"), optional for backward compat. */
  version?: string;
}
export interface ProvenanceResult {
  /** The workflow identity named in the signing certificate (a GitHub Actions job URL). */
  workflow: string;
}

/** True when a version is a Branch beta prerelease: e.g. "0.19.4-beta.5" (same pattern as betaReleaseVersion in updater). */
function isBetaVersion(version: string | undefined): boolean {
  if (!version) return false;
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);
}

/** `https://github.com/<repo>/.github/workflows/package.yml@refs/tags/v1.2.3` (a final release tag, as package.yml is triggered by). */
function releaseWorkflowIdentity(repo: string): RegExp {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = String.raw`v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?`;
  return new RegExp(String.raw`^URI:https://github\.com/` + escaped + String.raw`/\.github/workflows/package\.yml@refs/tags/` + tag + "$");
}

/** `https://github.com/<repo>/.github/workflows/beta.yml@refs/heads/mac/cross-platform` (beta releases run on that branch). */
function betaWorkflowIdentity(repo: string): RegExp {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`^URI:https://github\.com/` + escaped + String.raw`/\.github/workflows/beta\.yml@refs/heads/mac/cross-platform$`);
}

/** Build workflow identity patterns for all trusted repos. */
function allTrustedReleaseWorkflows(): RegExp[] {
  return TRUSTED_REPOS.map(releaseWorkflowIdentity);
}

/** Build beta workflow identity patterns for all trusted repos. */
function allTrustedBetaWorkflows(): RegExp[] {
  return TRUSTED_REPOS.map(betaWorkflowIdentity);
}

/**
 * Verifies one build-provenance bundle: its statement is about this exact file, the signature over
 * it matches the certificate GitHub returned with it, and that certificate names this repository's
 * release workflow run for a version tag. It does not verify the certificate's chain (see the
 * file-level comment). Throws a plain sentence, safe to show as-is, naming what failed; never
 * returns a partial or "probably fine" result.
 */
export function verifyAttestationBundle(bundle: AttestationBundle, expected: ProvenanceExpectation): ProvenanceResult {
  const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64");
  let parsedPayload: unknown;
  try { parsedPayload = JSON.parse(payload.toString("utf8")); }
  catch { throw new Error("the provenance record's statement could not be read"); }
  const statement = inTotoStatementSchema.safeParse(parsedPayload);
  if (!statement.success) throw new Error("the provenance record's statement could not be read");
  if (!statement.data.subject.some((entry) => entry.digest.sha256?.toLowerCase() === expected.digestHex.toLowerCase()))
    throw new Error("the provenance record is for a different file");

  const rawCert = bundle.verificationMaterial.certificate ?? bundle.verificationMaterial.x509CertificateChain?.certificates[0];
  if (!rawCert) throw new Error("the provenance record did not include a signing certificate");
  let cert: X509Certificate;
  try { cert = new X509Certificate(Buffer.from(rawCert.rawBytes, "base64")); }
  catch { throw new Error("the provenance record's signing certificate could not be read"); }
  // Fulcio issues these certificates to be valid for about ten minutes around the moment of
  // signing, not to stay valid afterwards — so what matters is whether the certificate was valid
  // when it signed, not whether it still is now, days or months later. That moment is the Rekor
  // transparency log entry's own timestamp, carried in the bundle for exactly this reason. Without
  // one (an older bundle shape, or none logged) there is nothing to check the window against, so
  // the window is left unchecked rather than compared to the wrong clock.
  const integratedTime = bundle.verificationMaterial.tlogEntries?.[0]?.integratedTime;
  if (integratedTime !== undefined) {
    const signedAt = Number(integratedTime) * 1000;
    if (!Number.isFinite(signedAt) || signedAt < Date.parse(cert.validFrom) || signedAt > Date.parse(cert.validTo))
      throw new Error("the provenance record's signing certificate was not valid when it was signed");
  }

  const names = (cert.subjectAltName ?? "").split(",").map((entry) => entry.trim());
  // Beta releases accept ONLY beta.yml@refs/heads/mac/cross-platform; final releases accept ONLY package.yml@refs/tags/vX.Y.Z.
  // Both trusted repos are accepted, regardless of which repo is being looked up.
  const isBeta = isBetaVersion(expected.version);
  const acceptedWorkflows = isBeta
    ? allTrustedBetaWorkflows()
    : allTrustedReleaseWorkflows();
  // A final release's record must come from the run for that release's own tag: a genuine record for
  // another version's file (an older one, served under a newer tag) is refused.
  const ownTag = !isBeta && expected.version !== undefined ? `@refs/tags/v${expected.version}` : null;
  const workflowEntry = names.find((entry) => acceptedWorkflows.some((pattern) => pattern.test(entry)) && (ownTag === null || entry.endsWith(ownTag)));
  if (!workflowEntry) throw new Error("the provenance record's signing certificate does not name this repository's release workflow for a version tag");

  const signature = bundle.dsseEnvelope.signatures[0]!;
  const pae = dssePae(bundle.dsseEnvelope.payloadType, payload);
  let signatureOk: boolean;
  try { signatureOk = createVerify("SHA256").update(pae).verify(cert.publicKey, Buffer.from(signature.sig, "base64")); }
  catch { throw new Error("the provenance record's signature could not be checked"); }
  if (!signatureOk) throw new Error("the provenance record's signature does not check out against its certificate");

  return { workflow: workflowEntry.slice("URI:".length) };
}
