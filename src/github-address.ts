/**
 * Reading a GitHub repository out of a remote address, shared by the pull-request hook and the
 * self-development contract (which cannot import the hook: the hook imports it).
 */

/** The GitHub repository behind a remote address, refusing an address that carries a password or token. */
export function githubRepositoryOf(address: string): { repo: string; https: URL } {
  const scp = /^git@github\.com:([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(address.trim());
  if (scp) return { repo: `${scp[1]}/${scp[2]}`, https: new URL(`https://github.com/${scp[1]}/${scp[2]}`) };
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw new Error("The remote is not an address Branch can read."); }
  if (url.password || (url.username && url.protocol !== "ssh:")) throw new Error("The remote address carries a sign-in. Remove it and let Git use this computer's own sign-in.");
  if (url.hostname.toLowerCase() !== "github.com") throw new Error("The remote is not on GitHub.");
  const parts = /^\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!parts) throw new Error("The remote address does not name a GitHub repository.");
  return { repo: `${parts[1]}/${parts[2]}`, https: new URL(`https://github.com/${parts[1]}/${parts[2]}`) };
}
