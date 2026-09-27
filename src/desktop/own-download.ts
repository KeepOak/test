/**
 * attach-anything: the only downloads the desktop window lets through are the page's own: a `blob:` address the page
 * made on the app's own origin (a file somebody attached, fetched through /api/attachments/file and handed over), or
 * the app's own attached-file route. Anything else a page could start (another site, a data: address) is refused.
 */
export function ownDownload(url: string, origin: string): boolean {
  if (url.startsWith("blob:")) return url.slice(5).startsWith(origin + "/");
  try {
    const target = new URL(url);
    return target.origin === origin && target.pathname === "/api/attachments/file";
  } catch {
    return false;
  }
}
