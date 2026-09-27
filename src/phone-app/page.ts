import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * mac7/phone-qr: the pages a phone sees after scanning the code, in the phone's own language.
 *
 * The language comes from the phone's `Accept-Language`, not from this computer's setting: the
 * person holding the phone reads it. Every sentence is a `phoneApp.page.*` key in
 * public/locales/<language>.json, with the English here as the fallback. Nothing on these pages
 * depends on anything in Branch but the file's size, and nothing on them is a pairing code: the
 * page is reached without a key, so pairing stays behind the owner's window.
 */
export const pageWords = {
  "phoneApp.page.title": "Install Branch on this phone",
  "phoneApp.page.step1": "Press Download.",
  "phoneApp.page.download": "Download Branch ({size})",
  "phoneApp.page.warning": "If the phone warns that the file could be harmful or cannot be downloaded securely, press Download anyway or Keep. It comes from your own computer, not from the internet.",
  "phoneApp.page.step2": "When it has downloaded, open it. If the phone says it cannot install apps from this source, press Settings, switch on Allow from this source, and go back. You only do this once.",
  "phoneApp.page.step3": "Press Install.",
  "phoneApp.page.step4": "Press Open.",
  "phoneApp.page.pairTitle": "Then connect it to your Branch",
  "phoneApp.page.pair": "In the Branch app, press Pair with a computer. On your computer, press Pair a phone: it shows the square code and its six numbers.",
  "phoneApp.page.update": "Already have Branch on this phone? Do the same again: it installs over the old one and stays connected.",
  "phoneApp.page.iphoneTitle": "Branch for iPhone is coming",
  "phoneApp.page.iphone": "This code installs the Android app, so nothing was downloaded to your iPhone. Today the iPhone app can only be installed from a Mac with Xcode, signed with your own Apple ID. Installing it by scanning a code is coming.",
  "phoneApp.page.refused": "This link has expired or is not right. On your computer, open Get Branch on your phone and scan the new code.",
} as const;
export type PageKey = keyof typeof pageWords;
export type Words = (key: PageKey, values?: Record<string, string>) => string;
export type Dictionaries = Record<string, Partial<Record<PageKey, string>>>;

/** Reads the `phoneApp.page.*` sentences of every language file Branch has. */
export async function loadDictionaries(localesDir: string): Promise<Dictionaries> {
  const out: Dictionaries = {};
  const names = await readdir(localesDir).catch(() => [] as string[]);
  for (const name of names.filter((entry) => /^[a-z]{2}(-[A-Za-z]{2})?\.json$/.test(entry))) {
    const all = JSON.parse(await readFile(join(localesDir, name), "utf8").catch(() => "{}")) as Record<string, unknown>;
    const words: Partial<Record<PageKey, string>> = {};
    for (const key of Object.keys(pageWords) as PageKey[]) if (typeof all[key] === "string") words[key] = all[key] as string;
    out[name.slice(0, -5).toLowerCase()] = words;
  }
  return out;
}

/** The first language the phone asks for that Branch has, or English. */
export function pickLanguage(acceptLanguage: string | undefined, have: readonly string[]): string {
  const asked = (acceptLanguage ?? "").split(",")
    .map((part) => { const [tag, q] = part.trim().split(";q="); return { tag: (tag ?? "").toLowerCase(), q: q ? Number(q) : 1 }; })
    .filter((entry) => entry.tag && entry.q > 0).sort((a, b) => b.q - a.q);
  for (const { tag } of asked) {
    if (have.includes(tag)) return tag;
    const base = tag.split("-")[0]!;
    if (have.includes(base)) return base;
  }
  return "en";
}

export function wordsFor(dictionaries: Dictionaries, language: string): Words {
  return (key, values = {}) => (dictionaries[language]?.[key] ?? pageWords[key])
    .replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

const style = "body{font:17px/1.5 system-ui,sans-serif;margin:0;padding:20px;background:#f6f4ee;color:#1d2a1f}"
  + "main{max-width:34rem;margin:auto}h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:2rem}"
  + "ol{padding-left:1.4rem}li{margin:.8rem 0}.note{color:#4a5a4c;font-size:.95rem}"
  + "a.download{display:inline-block;margin:.4rem 0;padding:.8rem 1.2rem;border-radius:10px;background:#2f5d3a;color:#fff;text-decoration:none;font-weight:600}";

function shell(language: string, title: string, body: string): string {
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>`
    + `<style>${style}</style></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
}

/** The Android page: download, allow this source once, install, open; then pairing. */
export function androidPage(say: Words, language: string, fileHref: string, size: number): string {
  const steps = [
    `${escape(say("phoneApp.page.step1"))}<br><a class="download" href="${escape(fileHref)}" download="Branch-Agent.apk">`
      + `${escape(say("phoneApp.page.download", { size: megabytes(size) }))}</a>`
      + `<p class="note">${escape(say("phoneApp.page.warning"))}</p>`,
    escape(say("phoneApp.page.step2")), escape(say("phoneApp.page.step3")), escape(say("phoneApp.page.step4")),
  ];
  return shell(language, say("phoneApp.page.title"), `<ol>${steps.map((step) => `<li>${step}</li>`).join("")}</ol>`
    + `<h2>${escape(say("phoneApp.page.pairTitle"))}</h2><p>${escape(say("phoneApp.page.pair"))}</p>`
    + `<p class="note">${escape(say("phoneApp.page.update"))}</p>`);
}

export function iphonePage(say: Words, language: string): string {
  return shell(language, say("phoneApp.page.iphoneTitle"), `<p>${escape(say("phoneApp.page.iphone"))}</p>`);
}

export function refusedPage(say: Words, language: string): string {
  return shell(language, say("phoneApp.page.title"), `<p>${escape(say("phoneApp.page.refused"))}</p>`);
}

/**
 * An iPhone, iPad or iPod. Every iPhone browser says "iPhone". An iPad set to show desktop sites
 * describes itself exactly as a Mac does and cannot be told apart from here; it is caught when it
 * adds the "Mobile/" token, and otherwise gets the Android page, which downloads nothing by itself.
 */
export function isApplePhone(userAgent: string | undefined): boolean {
  const agent = userAgent ?? "";
  return /\b(iPhone|iPad|iPod)\b/.test(agent) || (/\bMacintosh\b/.test(agent) && /\bMobile\//.test(agent));
}
