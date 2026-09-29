/**
 * Who really sent a mail. The From: line is written by whoever sent the message, so on its own it proves nothing;
 * what can be trusted is the Authentication-Results header the owner's own mail server stamps when the message
 * arrives, saying whether the sending domain's DMARC, SPF or DKIM checks passed. A sender is taken as the address
 * in From: only when that header vouches for the From domain; otherwise the mail is from a stranger.
 *
 * Ported from Hermes Agent's email adapter (`_extract_email_address`, `_ar_clauses`, `_auth_props` and
 * `_verify_sender_authentication` in plugins/platforms/email/adapter.py, https://github.com/NousResearch/hermes-agent,
 * commit 3f4533b, Copyright (c) 2025 Nous Research, MIT), where it closed the same gap (GHSA-rxqh-5572-8m77).
 * Branch is stricter in one place: the header it reads must be the only one from the trusted server.
 */
export interface SenderCheck { authenticated: boolean; reason: string }

/** A From: value longer than this is not a real sender and is not parsed. */
const maxFromLength = 2048;
/** A clause that is a verdict (`dmarc=pass`), read only at the start of a clause. */
const methodAt = /^\s*(dmarc|dkim|spf)\s*=\s*([a-z]+)/i;
const quoted = String.raw`"(?:[^"\\]|\\.)*"`;
/** One token of a clause: a property that names a domain, or any other token, stepped over whole. */
const propertyToken = new RegExp(String.raw`(header\.from|header\.d|header\.i|smtp\.mailfrom|smtp\.from|envelope-from)\s*=\s*((?:${quoted}|[^\s";])+)|(?:${quoted}|[^\s"])+`, "gi");

/**
 * Walks a header value, dropping (possibly nested) comments and, when asked, quoted strings, and splitting on
 * `separator` only where it is outside both. Null when a quote or comment is left open.
 */
function outside(text: string, separator: string, keepQuoted: boolean): string[] | null {
  const parts: string[] = [];
  let current = "", depth = 0, inQuote = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "\\" && (inQuote || depth)) { if (inQuote && keepQuoted) current += text.slice(at, at + 2); at++; continue; }
    if (inQuote) { inQuote = char !== '"'; if (keepQuoted) current += char; else if (!inQuote) current += " "; continue; }
    if (depth) { depth += char === "(" ? 1 : char === ")" ? -1 : 0; if (!depth) current += " "; continue; }
    if (char === "(") depth = 1;
    else if (char === '"') { inQuote = true; if (keepQuoted) current += char; }
    else if (char === ")") return null;
    else if (char === separator) { parts.push(current); current = ""; }
    else current += char;
  }
  return inQuote || depth ? null : [...parts, current];
}

/**
 * The one address a From: value names, lowercased, or "" when it does not name exactly one. Quoted display names and
 * comments are removed first, so `"boss@example.com <boss@example.com>" <someone@else.test>` is someone@else.test.
 */
export function fromAddress(raw: string): string {
  const value = raw.replace(/\r?\n[ \t]+/g, " ");
  if (value.length > maxFromLength) return "";
  const pieces = outside(value, "\u0000", false);
  if (!pieces || pieces.length !== 1) return "";
  const bare = pieces[0]!;
  const angles = [...bare.matchAll(/<([^<>]*)>/g)];
  const rest = bare.replace(/<[^<>]*>/, "");
  let address: string;
  // A display name may hold commas ("Doe, John <j@x>") but not a second address, unless it is the same one.
  if (angles.length === 1 && !/[<>;:]/.test(rest) && (!rest.includes("@") || rest.trim().toLowerCase() === angles[0]![1]!.trim().toLowerCase()))
    address = angles[0]![1]!;
  else if (!angles.length && !/[<>,;:]/.test(bare)) address = bare;
  else return "";
  address = address.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : "";
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
/** Relaxed DMARC alignment: the same domain, or one is a subdomain of the other. */
export function aligned(a: string, b: string): boolean {
  const x = a.trim().toLowerCase().replace(/\.$/, ""), y = b.trim().toLowerCase().replace(/\.$/, "");
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

/** The server that wrote a header (its authserv-id), or "" when the header starts straight with a verdict. */
function serverOf(value: string): string {
  const first = (outside(value, ";", true)?.[0] ?? value.split(";")[0] ?? "").trim();
  return methodAt.test(first) ? "" : (first.split(/\s+/)[0] ?? "").toLowerCase();
}

/** Each verdict, with the domains its own clause names; null when the header cannot be split safely. */
function verdicts(value: string): { method: string; result: string; props: [string, string][] }[] | null {
  const clauses = outside(value, ";", true);
  if (!clauses) return null;
  return clauses.flatMap((clause) => {
    const head = methodAt.exec(clause);
    if (!head) return [];
    const props = [...clause.matchAll(propertyToken)].filter((match) => match[1])
      .map((match) => [match[1]!.toLowerCase(), match[2]!.replace(/^"|"$/g, "")] as [string, string]);
    return [{ method: head[1]!.toLowerCase(), result: head[2]!.toLowerCase(), props }];
  });
}

/**
 * Whether the From: domain passed, by the receiving server's own Authentication-Results. `results` are that header's
 * values, top first. The trusted server is `authservId` when the owner named it, and otherwise the one that wrote
 * the top header (a receiving server adds its header above everything the sender wrote). Headers from any other
 * server are ignored, and a second header claiming the trusted server makes the mail unauthenticated.
 */
export function checkSender(results: readonly string[], from: string, authservId = ""): SenderCheck {
  const fromDomain = from.includes("@") ? domainOf(from) : "";
  if (!fromDomain) return { authenticated: false, reason: "no sender address" };
  const values = results.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!values.length) return { authenticated: false, reason: "no Authentication-Results header" };
  const pin = authservId.trim().toLowerCase();
  const trustedServer = pin || serverOf(values[0]!);
  const trusted = values.filter((value) => { const server = serverOf(value); return server === trustedServer || (!!pin && aligned(server, pin)); });
  if (!trusted.length) return { authenticated: false, reason: "no Authentication-Results from the trusted mail server" };
  if (trusted.length > 1) return { authenticated: false, reason: "more than one Authentication-Results from the trusted mail server" };
  const found = verdicts(trusted[0]!);
  if (!found) return { authenticated: false, reason: "an unbalanced quote or comment in Authentication-Results" };
  return judge(found, fromDomain);
}

/** DMARC pass, one aligned SPF pass, or an aligned DKIM pass; anything else is unauthenticated. */
function judge(found: NonNullable<ReturnType<typeof verdicts>>, fromDomain: string): SenderCheck {
  const alignedAll = (props: [string, string][], names: string[], required: boolean) => {
    const domains = props.filter(([name]) => names.includes(name)).map(([, value]) => domainOf(value));
    return (domains.length > 0 || !required) && domains.every((domain) => aligned(domain, fromDomain));
  };
  const dmarc = found.filter((verdict) => verdict.method === "dmarc");
  if (dmarc.length > 1) return { authenticated: false, reason: "more than one DMARC verdict" };
  if (dmarc.some((verdict) => verdict.result === "pass" && alignedAll(verdict.props, ["header.from"], false))) return { authenticated: true, reason: "dmarc=pass" };
  // One delivery has one envelope sender, so a second SPF verdict means neither can be trusted.
  const spf = found.filter((verdict) => verdict.method === "spf");
  if (spf.length === 1 && spf[0]!.result === "pass" && alignedAll(spf[0]!.props, ["smtp.mailfrom", "smtp.from", "envelope-from"], true))
    return { authenticated: true, reason: "spf=pass aligned" };
  // Several DKIM verdicts are normal (one per signature); any pass whose own signing domain aligns is enough.
  const signer = (props: [string, string][]) => ["header.d", "header.i", "header.from"].find((name) => props.some(([key]) => key === name)) ?? "header.d";
  if (found.some((verdict) => verdict.method === "dkim" && verdict.result === "pass" && alignedAll(verdict.props, [signer(verdict.props)], true)))
    return { authenticated: true, reason: "dkim=pass aligned" };
  return { authenticated: false, reason: "the sender's domain did not pass DMARC, SPF or DKIM" };
}
