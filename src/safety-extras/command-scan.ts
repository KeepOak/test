/**
 * mac7/r17-g (R17-064): reading a command for three tricks before it runs.
 *
 *  - hidden terminal codes: an escape character, another control character, a right-to-left or
 *    invisible mark. What the owner reads on the question card is then not what the shell reads.
 *    A command carrying one is refused outright: there is no honest reason to send one.
 *  - look-alike letters: a program name or web address that mixes alphabets (a Cyrillic letter in
 *    place of the Latin c of curl), uses full-width letters, or an address spelled in punycode
 *    ("xn--"). It is asked about.
 *  - a download piped straight into a program that runs it (`curl … | sh`, `bash <(wget …)`,
 *    `iwr … | iex`). It is asked about, because nobody has read what will run.
 *
 * Integration review: the command is first read the way a shell joins its words (`c''url`, `s\h`,
 * `"bash"`, `$IFS`), a decoder (`base64 -d`, `openssl … -d`, `xxd -r`) counts like a download, a
 * program may be named by its path or `$SHELL`, look-alike letters are found by Unicode's own
 * compatibility folding (mathematical and full-width letters alike), a program name with any letter
 * outside plain ASCII is asked about, and every invisible format character is a hidden code.
 *
 * The scan can only make the answer stricter: allow becomes ask, and ask or allow becomes refuse.
 * The ideas follow Hermes Agent's `tools/threat_patterns.py` and its tirith command check (MIT);
 * the patterns were written here (see THIRD_PARTY_NOTICES.md).
 */
import { dangerousCommand } from "./dangerous-commands.js";

/** Owner ruling 2026-09-30: "dangerous" is a command on Hermes Agent's dangerous-command list (./dangerous-commands.ts). */
export type ScanKind = "escape" | "homograph" | "pipe-to-shell" | "dangerous";
export interface ScanFinding { kind: ScanKind; detail: string }

/** C0 controls other than tab, line feed and carriage return; DEL; C1 controls. */
const controlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
/**
 * Marks that turn text around or hide it: every Unicode format character (bidi controls, zero-width
 * marks, the soft hyphen, tag characters, BOM), plus the fillers and selectors that draw as nothing.
 */
const hiddenMark = String.raw`[\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]`;
const hiddenMarks = new RegExp(hiddenMark, "u");
const fullWidth = /[\uff01-\uff5e]/u;
const scripts: readonly [string, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u], ["Cyrillic", /\p{Script=Cyrillic}/u], ["Greek", /\p{Script=Greek}/u],
  ["Armenian", /\p{Script=Armenian}/u], ["Cherokee", /\p{Script=Cherokee}/u],
];

const downloaders = String.raw`(?:curl|wget|fetch|aria2c|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|http|xh)\b`;
/** Turning hidden text back into a script counts like a download: nobody has read what comes out. */
const decoders = String.raw`(?:base64\b[^|;&]*\s(?:-d|-D|--decode)\b|openssl\b[^|;&]*\s-d\b|xxd\b[^|;&]*\s-r|uudecode\b)`;
const sources = `(?:${downloaders}|${decoders})`;
const pathTo = String.raw`(?:[^\s|;&()<>]*/)?`;
const runners = String.raw`(?:${pathTo}sudo\s+(?:-\S+\s+)*)?(?:${pathTo}env\s+(?:-\S+\s+)*)?(?:${pathTo}(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[0-9.]*|perl|ruby|node|deno|bun|php|pwsh|powershell|iex|Invoke-Expression|osascript|source|\.)|\$\{?SHELL\}?)`;
const ends = String.raw`(?=\s|$|;|&|\)|\|)`;
const pipePatterns: readonly RegExp[] = [
  // curl https://x | sh   ·   wget -qO- x | tee f | sudo bash   ·   base64 -d f | sh   ·   iwr x | iex
  new RegExp(String.raw`(?:^|[;&|(\s])${sources}[^;&]*\|\s*${runners}${ends}`, "i"),
  // bash <(curl x)   ·   source <(base64 -d f)
  new RegExp(String.raw`${runners}\s+<\(\s*${sources}`, "i"),
  // bash -c "$(curl x)"   ·   eval "$(wget x)"   ·   sh -c `base64 -d f`
  new RegExp(String.raw`(?:${runners}\s+-c|eval)\s+(?:\$\(|\x60)\s*${sources}`, "i"),
];

/** The command as a shell joins its words: line continuations, quotes and backslashes inside a word dropped, `$IFS` a space. */
export function shellReading(command: string): string {
  return command.replace(/\\\r?\n/g, "")
    .replace(/\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g, " ")
    .replace(/["']/g, "")
    .replace(/\\([^\s])/g, "$1");
}

const words = (command: string): string[] => command.split(/[\s"'`=|;&()<>]+/).filter(Boolean);
const scriptsOf = (word: string): string[] => scripts.filter(([, pattern]) => pattern.test(word)).map(([name]) => name);

function escapeFinding(command: string): ScanFinding | null {
  const control = controlChars.exec(command);
  if (control) return { kind: "escape", detail: `a hidden control character (U+${hex(control[0])})` };
  const mark = hiddenMarks.exec(command);
  if (mark) return { kind: "escape", detail: `an invisible or right-to-left mark (U+${hex(mark[0])})` };
  return null;
}
const hex = (char: string): string => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");

/** The first word that looks like something it is not, or null. */
function homographFinding(command: string): ScanFinding | null {
  for (const word of words(command)) {
    if (fullWidth.test(word)) return { kind: "homograph", detail: `"${word}" uses full-width letters` };
    if (word.normalize("NFKC") !== word.normalize("NFC")) return { kind: "homograph", detail: `"${word}" uses letters that only look like plain ones` };
    const mixed = scriptsOf(word);
    if (mixed.length > 1) return { kind: "homograph", detail: `"${word}" mixes ${mixed.join(" and ")} letters` };
    const host = hostOf(word);
    if (host && host.split(".").some((label) => label.startsWith("xn--")))
      return { kind: "homograph", detail: `the address ${host} is spelled in punycode` };
    if (host && /[^\x00-\x7f]/.test(host)) return { kind: "homograph", detail: `the address ${host} uses letters outside plain ASCII` };
  }
  // A mark the shell cannot see is reported as a hidden code already; here only letters count.
  const program = programNames(command).find((name) => /[^\x00-\x7f]/.test(name.replace(new RegExp(hiddenMark, "gu"), "")));
  return program ? { kind: "homograph", detail: `the program name "${program}" uses letters outside plain ASCII` } : null;
}
/** The program each part of a command starts, past `sudo`, `env` and `NAME=value`. */
function programNames(command: string): string[] {
  return command.split(/[|;&(`\n]+|\$\(/).map((part) => part.trim().split(/\s+/)
    .find((word) => word && !/^(sudo|env|exec|command|nohup|time)$/.test(word) && !/^-/.test(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "")
    .filter(Boolean);
}
/** The host a word names: from a full address, or a bare `name.tld` at its start. */
function hostOf(word: string): string | null {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/iu.exec(word);
  if (url) return url[1]!.toLowerCase();
  const bare = /^([^/:?#@]+\.[\p{L}a-z-]{2,})(?:[/:]|$)/iu.exec(word);
  return bare ? bare[1]!.toLowerCase() : null;
}

function pipeFinding(command: string): ScanFinding | null {
  return pipePatterns.some((pattern) => pattern.test(command))
    ? { kind: "pipe-to-shell", detail: "a download is handed straight to a program that runs it" }
    : null;
}

/** Everything the scan finds in one command, most serious first. */
export function scanCommand(command: string): ScanFinding[] {
  const read = shellReading(command);
  return [escapeFinding(command), homographFinding(read), pipeFinding(read), dangerousFinding(command, read)]
    .filter((finding): finding is ScanFinding => finding !== null);
}
function dangerousFinding(command: string, read: string): ScanFinding | null {
  const found = dangerousCommand(command, read);
  return found ? { kind: "dangerous", detail: `it is a dangerous command (${found})` } : null;
}

export type Decision = "allow" | "ask" | "deny";
/** The stricter answer the findings call for. Never looser than `decision`. */
export function tightenForFindings(decision: Decision, findings: readonly ScanFinding[]): Decision {
  if (decision === "deny" || findings.length === 0) return decision;
  if (findings.some((finding) => finding.kind === "escape")) return "deny";
  return "ask";
}

/** One plain sentence for the question card or the refusal. */
export function findingSentence(findings: readonly ScanFinding[]): string {
  const hidden = findings.find((finding) => finding.kind === "escape");
  if (hidden) return `This command carries ${hidden.detail}, so what you would read is not what would run. It was not run.`;
  return `Check this command first: ${findings.map((finding) => finding.detail).join("; ")}.`;
}
