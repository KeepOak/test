/** The checked renderer needs only these reads before accepting an engine; all other requests wait. */
export function previewRequest(method: string | undefined, path: string): boolean {
  if (method !== "GET") return false;
  if (["/", "/index.html", "/api/state", "/api/trunks", "/api/sessions", "/api/profiles", "/api/policy", "/api/usage", "/api/commands"].includes(path)) return true;
  if (/^\/api\/sessions\/[a-f0-9-]{36}(?:\/(?:pins|followups|context))?$/.test(path)) return true;
  if (/^\/locales\/(?:de|en|es|fr)\.json$/.test(path)) return true;
  return !path.startsWith("/api/") && !path.includes("..") && /^\/[A-Za-z0-9_./-]+\.(?:js|css|svg|png|jpe?g|webp|ico|woff2?)$/.test(path);
}
