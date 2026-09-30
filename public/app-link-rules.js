/** Reviewed catalogue. Add targets by exact HTTPS hosts and resource paths; credentials never cross this boundary. */
export const appLinkTargets = [
  { name: "Airbnb", kind: "listing", hosts: ["airbnb.com", "www.airbnb.com"], host: "www.airbnb.com", path: /^\/rooms\/[0-9]{1,20}\/?$/ },
  { name: "Spotify", kind: "track", hosts: ["open.spotify.com"], host: "open.spotify.com", path: /^\/track\/[A-Za-z0-9]{22}\/?$/ },
];
export function appLinkDetails(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const target = appLinkTargets.find((entry) => entry.hosts.includes(url.hostname) && entry.path.test(url.pathname));
    return target ? { url: `https://${target.host}${url.pathname.replace(/\/$/, "")}`, name: target.name, kind: target.kind } : null;
  } catch { return null; }
}
export const appLinkUrl = (value) => appLinkDetails(value)?.url ?? null;
