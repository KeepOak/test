/**
 * Codex's own account folder and already-configured network transport. Keep this separate from
 * the general child environment: other programs still get their existing short allowlist.
 * No API keys, endpoint overrides, client identities or TLS-verification bypasses are copied.
 */
const allowed = [
  "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
];
export function codexTransportEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of allowed) if (source[name] !== undefined) out[name] = source[name];
  return out;
}
