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

/** Windows child environment names share one identity. Refuse conflicting aliases instead of
 * guessing which account or transport value the child would receive. POSIX keeps distinct names. */
export function codexChildEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...source };
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (out[key] !== undefined && out[key] !== value)
      throw new Error("Codex's Windows environment contains conflicting account or transport variable aliases. Reconcile their values before continuing.");
    out[key] = value;
  }
  return out;
}