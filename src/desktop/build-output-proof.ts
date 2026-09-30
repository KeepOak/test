import { createVerify, X509Certificate } from "node:crypto";
import { TRUSTED_REPOS } from "./repo-pair.js";
import { dssePae, isBuildProvenance, type AttestationBundle } from "./provenance.js";

/**
 * The proof that a Beta change's build output (build-output.ts) is what GitHub's own machine built from exactly that
 * change: a build-provenance record, signed with a certificate that Sigstore's public certificate authority (Fulcio)
 * issued to Branch's `beta-output.yml` workflow running on Beta's line, about this exact file and this exact commit.
 *
 * Unlike a Stable release's record (provenance.ts), this one replaces a check rather than adding to one: the output is
 * code the app runs, used instead of compiling the change here. So the certificate is walked up to Fulcio's own
 * certificates, kept below exactly as Sigstore publishes them (github.com/sigstore/root-signing,
 * targets/trusted_root.json, the CA valid from 2022-04-13), and anything that does not check out in full is refused.
 * A refusal is never a failed update: the change is then compiled on this computer, as before.
 *
 * Only that workflow can be issued such a certificate: Fulcio names the workflow file and the branch it ran on, from
 * GitHub's own sign-in token for the run. The workflow signs in a job that runs none of the change's code (it only
 * hashes the file the build job left), so nothing the change installs can ask for a certificate.
 */
const fulcioIntermediate =
  "MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREw" +
  "DwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEe" +
  "MBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9Nl" +
  "arYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXn" +
  "o3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Pp" +
  "z1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DY" +
  "iZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3" +
  "BxsPmygUY7Ii2zbdCdliiow=";
const fulcioRoot =
  "MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREw" +
  "DwYDVQQDEwhzaWdzdG9yZTAeFw0yMTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjER" +
  "MA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4" +
  "ynB07ceb3LP0OIOZdxexX69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92jYzBhMA4GA1UdDwEB" +
  "/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRYwB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWl" +
  "Zql6zJChkyLQKsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCMWP/WHPqpaVo0jhsweNFZgSs0" +
  "eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ";

/** Which workflow, on which line, may sign a build output. */
export const outputWorkflowPath = ".github/workflows/beta-output.yml";
export const outputWorkflowRef = "refs/heads/redesign/window";

const certificate = (base64: string) => new X509Certificate(Buffer.from(base64, "base64"));

/** Whether `leaf` was issued by Fulcio: signed by its intermediate, which its root signed, each in date at `at`. */
export function issuedByFulcio(leaf: X509Certificate, at: number, chain = { intermediate: certificate(fulcioIntermediate), root: certificate(fulcioRoot) }): boolean {
  const inDate = (cert: X509Certificate) => at >= Date.parse(cert.validFrom) && at <= Date.parse(cert.validTo);
  try {
    return leaf.checkIssued(chain.intermediate) && leaf.verify(chain.intermediate.publicKey) && inDate(leaf)
      && chain.intermediate.checkIssued(chain.root) && chain.intermediate.verify(chain.root.publicKey) && inDate(chain.intermediate)
      && chain.root.verify(chain.root.publicKey);
  } catch { return false; }
}

interface Statement {
  subject?: { digest?: { sha256?: string } }[];
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } };
      resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
    };
  };
}

export interface OutputExpectation { digestHex: string; commit: string }

/** Throws a plain sentence naming what did not check out; returns the signing workflow's address when all did. */
export function verifyOutputBundle(bundle: AttestationBundle, expected: OutputExpectation, chain?: Parameters<typeof issuedByFulcio>[2]): string {
  if (!isBuildProvenance(bundle)) throw new Error("the record is not a build-provenance record");
  const payload = Buffer.from(bundle.dsseEnvelope.payload, "base64");
  let statement: Statement;
  try { statement = JSON.parse(payload.toString("utf8")) as Statement; } catch { throw new Error("the record's statement could not be read"); }
  if (!statement.subject?.some((entry) => entry.digest?.sha256?.toLowerCase() === expected.digestHex.toLowerCase()))
    throw new Error("the record is for a different file");
  const raw = bundle.verificationMaterial.certificate ?? bundle.verificationMaterial.x509CertificateChain?.certificates[0];
  if (!raw) throw new Error("the record has no signing certificate");
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(Buffer.from(raw.rawBytes, "base64")); } catch { throw new Error("the record's signing certificate could not be read"); }
  const integrated = bundle.verificationMaterial.tlogEntries?.[0]?.integratedTime;
  const signedAt = Number(integrated) * 1000;
  if (integrated === undefined || !Number.isFinite(signedAt)) throw new Error("the record does not say when it was signed");
  if (!issuedByFulcio(leaf, signedAt, chain)) throw new Error("the record's signing certificate was not issued by Sigstore's certificate authority when it signed");
  const names = (leaf.subjectAltName ?? "").split(",").map((entry) => entry.trim());
  const signer = TRUSTED_REPOS.map((repo) => `URI:https://github.com/${repo}/${outputWorkflowPath}@${outputWorkflowRef}`).find((name) => names.includes(name));
  if (!signer) throw new Error("the record was not signed by Branch's build-output workflow on Beta's line");
  const repo = TRUSTED_REPOS.find((one) => signer.includes(`/${one}/`))!;
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  if (workflow?.path !== outputWorkflowPath || workflow.ref !== outputWorkflowRef || workflow.repository !== `https://github.com/${repo}`)
    throw new Error("the record names another workflow");
  if (!definition?.resolvedDependencies?.some((dep) => dep.digest?.gitCommit === expected.commit))
    throw new Error("the record is for a different change");
  const signature = bundle.dsseEnvelope.signatures[0]!;
  let ok = false;
  try { ok = createVerify("SHA256").update(dssePae(bundle.dsseEnvelope.payloadType, payload)).verify(leaf.publicKey, Buffer.from(signature.sig, "base64")); }
  catch { ok = false; }
  if (!ok) throw new Error("the record's signature does not check out against its certificate");
  return signer.slice("URI:".length);
}
