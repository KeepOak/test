/**
 * Adapted from Hermes Agent plugins/platforms/email/adapter.py, commit a9a54245b23,
 * Copyright (c) 2025 Nous Research, MIT; see THIRD_PARTY_NOTICES.md.
 */
interface Verdict { method: string; result: string; properties: [string, string][] }

/** Semicolons inside comments or quoted strings never start authentication verdicts. */
function clauses(text: string): string[] | null {
  const output: string[] = [];
  let current = "", depth = 0, quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "\\" && (quoted || depth)) {
      if (at + 1 === text.length) return null;
      if (quoted) current += text.slice(at, at + 2);
      at++; continue;
    }
    if (quoted) { quoted = char !== '"'; current += char; }
    else if (depth) { depth += char === "(" ? 1 : char === ")" ? -1 : 0; if (!depth) current += " "; }
    else if (char === "(") depth = 1;
    else if (char === '"') { quoted = true; current += char; }
    else if (char === ")") return null;
    else if (char === ";") { output.push(current); current = ""; }
    else current += char;
  }
  return quoted || depth ? null : [...output, current];
}

/** Consume other tokens whole, so property-shaped text inside their quoted values is ignored. */
function properties(text: string): [string, string][] {
  const token = /(header\.from|header\.d|smtp\.mailfrom|smtp\.from|envelope-from)\s*=\s*((?:"(?:[^"\\]|\\.)*"|[^\s";])+)|(?:"(?:[^"\\]|\\.)*"|[^\s"])+/gi;
  return [...text.matchAll(token)].filter((match) => match[1]).map<[string, string]>((match) => [match[1]!.toLowerCase(), match[2]!.replace(/^"|"$/g, "")]);
}

/** SPF/DKIM fallback uses exact alignment; no guessed public-suffix relationships. */
function domain(value: string): string {
  const name = value.slice(value.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ? name : "";
}
function aligned(verdict: Verdict, names: string[], from: string, required = true): boolean {
  const values = verdict.properties.filter(([name]) => names.includes(name)).map(([, value]) => domain(value));
  return (!required || values.length > 0) && values.every((value) => value === from);
}

/**
 * Only the first receiving-server header is considered. The provider must strip forged results
 * and prepend its verdict; pins are exact authserv-ids, never suffix matches or later headers.
 */
export function authenticatedSender(from: string, firstResult: string | undefined, trustedIds: readonly string[] = []): boolean {
  const fromDomain = domain(from);
  if (!from.includes("@") || !fromDomain || !firstResult || firstResult.length > 16384) return false;
  const parts = clauses(firstResult);
  if (!parts || parts.length < 2) return false;
  const server = parts.shift()!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*(?:\s+1)?$/.test(server)) return false;
  const serverId = server.replace(/\s+1$/, "");
  if (trustedIds.length && !trustedIds.some((id) => id.toLowerCase() === serverId)) return false;
  const verdicts: Verdict[] = parts.flatMap((part) => {
    const head = /^\s*(dmarc|spf|dkim)\s*=\s*([a-z]+)(?=\s|$)/i.exec(part);
    return head ? [{ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), properties: properties(part) }] : [];
  });
  const dmarc = verdicts.filter((v) => v.method === "dmarc");
  if (dmarc.length > 1) return false;
  if (dmarc.some((v) => v.result === "pass" && aligned(v, ["header.from"], fromDomain, false))) return true;
  const spf = verdicts.filter((v) => v.method === "spf");
  if (spf.length === 1 && spf[0]!.result === "pass" && aligned(spf[0]!, ["smtp.mailfrom", "smtp.from", "envelope-from"], fromDomain)) return true;
  return verdicts.some((v) => v.method === "dkim" && v.result === "pass" && aligned(v, ["header.d"], fromDomain));
}
