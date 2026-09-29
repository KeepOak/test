/**
 * Where a web address came from. A task that reads private things and may also open web addresses could hide what it
 * read inside an address it makes up (https://example.com/?q=<the owner's notes>), and a site's log would keep it. A
 * task held to this rule may only open an address that was already written down before it made any choice: in its
 * own instructions, among the owner's sources, or in what a search or page it opened in the same task returned. An
 * address it wrote itself is refused. Such addresses were fixed by the owner or by a site, never by the task, so
 * nothing it read can travel out in them.
 *
 * The idea is the URL validation of Anthropic's web fetch tool (platform.claude.com/docs/en/agents-and-tools/tool-use/
 * web-fetch-tool: only addresses already in the conversation or in earlier search and fetch results); that tool is
 * closed source, so only the idea is used and the code is written here. OpenClaw's web_fetch guards (private
 * addresses, redirects, host allow and deny lists, MIT) and Codex's network proxy (a domain allowlist, Apache-2.0) were
 * studied too; they limit where a request may go rather than where its address came from, and nothing was copied.
 */

/** One address in the form it is compared in: http or https only, without its #fragment. */
export function normalAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Every http(s) address written in a text, normalised; trailing punctuation from the sentence is left out. */
export function addressesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>()[\]{}`\\|^]+/gi)) {
    const address = normalAddress(match[0].replace(/[.,;:!?]+$/, ""));
    if (address) found.push(address);
  }
  return found;
}

/** Every address a tool call's arguments name, however deep in them (a few levels). */
export function addressesInArgs(args: unknown, depth = 0): string[] {
  if (typeof args === "string") return addressesIn(args);
  if (!args || typeof args !== "object" || depth > 4) return [];
  const values = Array.isArray(args) ? args : Object.values(args as Record<string, unknown>);
  return values.flatMap((value) => addressesInArgs(value, depth + 1));
}

/** The first address in a call that is not among the known ones, or null when every one is known. */
export function unknownAddress(args: unknown, known: ReadonlySet<string>): string | null {
  return addressesInArgs(args).find((address) => !known.has(address)) ?? null;
}
