/** Extend this reviewed catalogue with exact hosts and read-only resource paths, never caller-supplied schemes. */
export const appLinkTargets = [
  { name: "Airbnb", kind: "listing", hosts: ["airbnb.com", "www.airbnb.com"], host: "www.airbnb.com", path: /^\/rooms\/[0-9]{1,20}\/?$/, desktopPrefix: null },
  { name: "Spotify", kind: "track", hosts: ["open.spotify.com"], host: "open.spotify.com", path: /^\/track\/[A-Za-z0-9]{22}\/?$/, desktopPrefix: "spotify:track:" },
] as const;
export function appLinkDetails(value: unknown): { url: string; name: string; kind: string; appUrl: string | null } | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const target = appLinkTargets.find((entry) => (entry.hosts as readonly string[]).includes(url.hostname) && entry.path.test(url.pathname));
    if (!target) return null;
    const path = url.pathname.replace(/\/$/, "");
    return { url: `https://${target.host}${path}`, name: target.name, kind: target.kind,
      appUrl: target.desktopPrefix ? target.desktopPrefix + path.slice(path.lastIndexOf("/") + 1) : null };
  } catch { return null; }
}
