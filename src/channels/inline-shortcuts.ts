/** Only transport-vouched authored text is scanned. Branch-written; OpenClaw's MIT fast path informed the scope. */
export interface AuthoredCommandText {
  text: string;
  protected: readonly { offset: number; length: number }[];
}
export interface InlineShortcuts { names: ("status" | "whoami")[]; remainder: string }

function protectedText(text: string, spans: AuthoredCommandText["protected"]): string | null {
  const mask = [...text.split("")];
  // Masked with a non-space mark, so a hidden span never makes a word boundary a shortcut could stand on.
  const hide = (start: number, length: number) => { for (let i = start; i < start + length; i++) mask[i] = "\u0000"; };
  for (const span of spans) {
    if (!Number.isSafeInteger(span.offset) || !Number.isSafeInteger(span.length) || span.offset < 0 || span.length < 0 || span.offset + span.length > text.length) return null;
    hide(span.offset, span.length);
  }
  // Quoted lines, fenced/inline code, literal quotes, links and URLs remain ordinary text.
  const protectedParts = /(^[ \t]*>[^\r\n]*|^[ \t]{4,}[^\r\n]*|```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*(?:`|$)|"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|\[[^\]\r\n]*\]\([^\r\n)]*\)|\S*:\/\/\S+)/gm;
  for (const match of text.matchAll(protectedParts)) hide(match.index!, match[0].length);
  return mask.join("");
}

export function inlineShortcuts(authored: AuthoredCommandText, actualText: string): InlineShortcuts | null {
  if (authored.text !== actualText || actualText.length > 16384) return null;
  const visible = protectedText(actualText, authored.protected); if (visible === null) return null;
  const matches = [...visible.matchAll(/(?:^|\s)(\/(status|whoami))(?=\s|$)/g)];
  if (!matches.length || matches.length > 16) return null;
  const names: InlineShortcuts["names"] = [], removed = new Set<number>();
  for (const match of matches) {
    const name = match[2] as "status" | "whoami";
    if (!names.includes(name)) names.push(name);
    const offset = match.index! + match[0].length - match[1]!.length;
    for (let i = offset; i < offset + match[1]!.length; i++) removed.add(i);
  }
  // Remove only exact tokens. Original whitespace, quotes, indentation and other text survive.
  return { names, remainder: actualText.split("").filter((_, index) => !removed.has(index)).join("") };
}
