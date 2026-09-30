/**
 * UP-CHAT-011 (CHAT-114, CHAT-115): a reply's Markdown in each app's own formatting, so nobody reads literal `**`,
 * `#` or backtick fences. One reading of the Markdown gives the words without their marks, plus where each style
 * lies. Offsets count UTF-16 code units, as JavaScript strings, Telegram entities and Signal's text styles all do.
 * - Telegram: message entities (keep-ours K2), never a parse mode, so no reply can fail with "can't parse entities".
 * - Signal: signal-cli's `textStyle` ranges (`start:length:STYLE`).
 * - WhatsApp: its own marks (`*bold*`, `_italic_`, `~strike~`, backticks for code).
 *
 * Adapted from Hermes Agent (MIT, Copyright (c) 2025 Nous Research), commit a9a54245:
 * gateway/platforms/signal_format.py `markdown_to_signal` and gateway/platforms/whatsapp_common.py `format_message`.
 * Unlike those, code is read first and nothing inside code is styled.
 */
export type StyleKind = "bold" | "italic" | "strike" | "code" | "pre" | "link";
export interface Style { offset: number; length: number; kind: StyleKind; language?: string; url?: string }
export interface Styled { text: string; styles: Style[] }

const fence = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n? {0,3}\1[ \t]*$/gm;
// One pass over a line's words, left to right; the first style to start at a place wins it.
const inline = new RegExp([
  "`([^`\\n]+)`",                                            // 1 code
  "\\[([^\\]\\n]+)\\]\\(((?:https?|tg):[^)\\s]+)\\)",   // 2 text, 3 address
  "\\*\\*(?=\\S)([^\\n]*?\\S)\\*\\*",                        // 4 bold
  "__(?=\\S)([^\\n]*?\\S)__",                                // 5 bold
  "~~(?=\\S)([^\\n]*?\\S)~~",                                // 6 strike
  "(?<![\\w*])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?![\\w*])", // 7 italic
  "(?<![\\w_])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?![\\w_])",     // 8 italic
].join("|"), "g");

/** Words with their styles, read from one stretch outside code blocks. Styles nest (bold around italic). */
function inlineStyles(source: string, at: number, out: Style[]): string {
  let text = "", end = 0;
  for (const match of source.matchAll(inline)) {
    text += source.slice(end, match.index);
    const start = at + text.length;
    if (match[1] !== undefined) { text += match[1]; out.push({ offset: start, length: match[1].length, kind: "code" }); }
    else {
      const inner = match[2] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8]!;
      const kind: StyleKind = match[2] !== undefined ? "link" : match[6] !== undefined ? "strike"
        : match[7] !== undefined || match[8] !== undefined ? "italic" : "bold";
      const words = inlineStyles(inner, start, out);
      text += words;
      out.push({ offset: start, length: words.length, kind, ...(kind === "link" ? { url: match[3]! } : {}) });
    }
    end = match.index + match[0].length;
  }
  return text + source.slice(end);
}

/** A stretch outside code blocks: headings become bold lines, list marks become bullets, quotes lose their `>`. */
function prose(source: string, at: number, out: Style[]): string {
  let text = "";
  for (const [index, raw] of source.split("\n").entries()) {
    if (index) text += "\n";
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(raw);
    const line = heading ? heading[1]! : raw.replace(/^( {0,3})[-*+][ \t]+(?=\S)/, "$1• ").replace(/^ {0,3}>[ \t]?/, "");
    const start = at + text.length;
    const words = inlineStyles(line, start, out);
    if (heading && words.trim()) out.push({ offset: start, length: words.length, kind: "bold" });
    text += words;
  }
  return text;
}

/** Reads Markdown into its words and their styles. Text with no Markdown in it comes back unchanged. */
export function readMarkdown(markdown: string): Styled {
  const styles: Style[] = [];
  let text = "", end = 0;
  for (const match of markdown.matchAll(fence)) {
    text += prose(markdown.slice(end, match.index), text.length, styles);
    const code = match[3]!, language = (match[2] ?? "").trim().split(/\s+/)[0] ?? "";
    if (code) styles.push({ offset: text.length, length: code.length, kind: "pre", ...(language ? { language } : {}) });
    text += code;
    end = match.index + match[0].length;
  }
  text += prose(markdown.slice(end), text.length, styles);
  return { text, styles: styles.filter((style) => style.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length) };
}

const telegramKind: Record<StyleKind, string> = { bold: "bold", italic: "italic", strike: "strikethrough", code: "code", pre: "pre", link: "text_link" };
/** Telegram message entities for a reply's Markdown (https://core.telegram.org/bots/api#messageentity). */
export function telegramMarkdown(markdown: string): { text: string; entities: Record<string, unknown>[] } {
  const { text, styles } = readMarkdown(markdown);
  return { text, entities: styles.map((style) => ({ type: telegramKind[style.kind], offset: style.offset, length: style.length,
    ...(style.language ? { language: style.language } : {}), ...(style.url ? { url: style.url } : {}) })) };
}

const signalKind: Record<StyleKind, string | null> = { bold: "BOLD", italic: "ITALIC", strike: "STRIKETHROUGH", code: "MONOSPACE", pre: "MONOSPACE", link: null };
/** signal-cli's words and `textStyle` ranges; a link keeps its address after its words, since Signal has no link style. */
export function signalMarkdown(markdown: string): { text: string; textStyle: string[] } {
  const { text, styles } = readMarkdown(withAddresses(markdown));
  return { text, textStyle: styles.flatMap((style) => signalKind[style.kind] ? [`${style.offset}:${style.length}:${signalKind[style.kind]}`] : []) };
}

/** `[words](address)` as "words (address)", for apps with no link style; code is left alone. */
function withAddresses(markdown: string): string {
  return markdown.replace(/(`{3,}[\s\S]*?`{3,}|`[^`\n]+`)|\[([^\]\n]+)\]\(((?:https?|tg):[^)\s]+)\)/g,
    (all, code, words, address) => (code ? all : words === address ? address : `${words} (${address})`));
}

const whatsappMark: Record<StyleKind, string> = { bold: "*", italic: "_", strike: "~", code: "`", pre: "```", link: "" };
/** WhatsApp's own marks for a reply's Markdown (https://faq.whatsapp.com/539178204879377). */
export function whatsappMarkdown(markdown: string): string {
  const { text, styles } = readMarkdown(withAddresses(markdown));
  // `nest` orders marks at one place: closings first, the innermost style (the latest to open) closing first, then
  // openings, the outermost (the longest) opening first.
  const marks: { at: number; mark: string; nest: number }[] = [];
  for (const style of styles) {
    const mark = whatsappMark[style.kind];
    if (!mark) continue;
    marks.push({ at: style.offset, mark: style.kind === "pre" ? `${mark}\n` : mark, nest: 1e9 - style.length },
      { at: style.offset + style.length, mark: style.kind === "pre" ? `\n${mark}` : mark, nest: -style.offset });
  }
  marks.sort((a, b) => a.at - b.at || a.nest - b.nest);
  let out = "", end = 0;
  for (const { at, mark } of marks) { out += text.slice(end, at) + mark; end = at; }
  return out + text.slice(end);
}
