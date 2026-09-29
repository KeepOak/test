import type { MessageFormat } from "./router.js";

/**
 * Code-block extraction, marker removal and native MONOSPACE ranges adapted from Hermes Agent
 * gateway/platforms/signal_format.py (MIT, Copyright (c) 2025 Nous Research). See THIRD_PARTY_NOTICES.md.
 * JavaScript offsets and lengths already count UTF-16 code units, as signal-cli textStyle requires.
 */
export function signalMonospace(source: string, format?: MessageFormat): { text: string; textStyle: string[] } {
  if (format?.plain) return { text: source, textStyle: [] };
  if (format?.spans?.length) {
    const styles = format.spans.filter((span) => Number.isInteger(span.offset) && Number.isInteger(span.length)
      && span.offset >= 0 && span.length > 0 && span.offset + span.length <= source.length)
      .map((span) => `${span.offset}:${span.length}:MONOSPACE`);
    return { text: source, textStyle: styles };
  }
  // A language label is stripped only when followed by a newline; a single-line fence retains its contents.
  const code = /```(?:[a-zA-Z0-9_+-]*\r?\n)?([\s\S]*?)```|`([^`\n]+)`/g;
  const textStyle: string[] = [];
  let text = "", end = 0;
  for (const match of source.matchAll(code)) {
    text += source.slice(end, match.index);
    const body = match[1] ?? match[2] ?? "";
    if (body.length) textStyle.push(`${text.length}:${body.length}:MONOSPACE`);
    text += body;
    end = match.index + match[0].length;
  }
  return { text: text + source.slice(end), textStyle };
}
