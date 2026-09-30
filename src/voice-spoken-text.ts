/** Port of Hermes prepare_spoken_text and SentenceChunker, a9a54245b231,
 * Copyright (c) 2025 Nous Research, MIT. Notice in THIRD_PARTY_NOTICES.md.
 * Branch adds a bounded sentence payload and abbreviation/decimal look-ahead.
 * Pipecat's BSD sentencex integration was inspected; no sentencex code is copied. */
export function prepareSpokenText(input: string): string {
  let text = stripNonspoken(input)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/https?:\/\/\S+|MEDIA:\S+/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, "$2")
    .replace(/(?<!\w)[*_]([^*_\n]+)[*_](?!\w)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1,")
    .replace(/^\s*(?:>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\s*\|\s*/g, "; ");
  text = symbols(text.replace(/&amp;/g, " and ").replace(/&lt;/g, "less than ")
    .replace(/&gt;/g, "greater than ").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  return text.split(/\r?\n/).map((line) => {
    const clean = line.trim();
    return clean && !/[.!?,;:]$/.test(clean) ? `${clean}.` : clean;
  }).join(" ").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function stripNonspoken(text: string): string {
  return text.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think(?:\s[^>]*)?>[\s\S]*$/gi, " ");
}
function symbols(text: string): string {
  const units: Record<string, string> = { "km/h": "kilometres per hour", mm: "millimetres", cm: "centimetres", m: "metres" };
  const currencies: Record<string, string> = { "NZ$": "New Zealand dollars", "A$": "Australian dollars", "US$": "US dollars", "$": "dollars", "€": "euros", "£": "pounds" };
  return text.replace(/\u2212/g, "-").replace(/…/g, "...")
    .replace(/([-+]?\d+(?:\.\d+)?)\s*[-–—]\s*([-+]?\d+(?:\.\d+)?)\s*°\s*([CF])\b/gi,
      (_, a: string, b: string, unit: string) => `${a} to ${b} degrees ${unit.toUpperCase() === "C" ? "Celsius" : "Fahrenheit"}`)
    .replace(/°\s*([CF])\b/gi, (_, unit: string) => ` degrees ${unit.toUpperCase() === "C" ? "Celsius" : "Fahrenheit"}`)
    .replace(/°/g, " degrees ")
    .replace(/(?<=\d)\s*(km\/h|mm|cm|m)\b/gi, (_, unit: string) => ` ${units[unit.toLowerCase()]}`)
    .replace(/(NZ\$|A\$|US\$|\$|€|£)\s*([\d,]*\d(?:\.\d+)?)/g,
      (_, unit: string, amount: string) => `${amount} ${currencies[unit]}`)
    .replace(/(?<=\d)\s*%/g, " percent").replace(/(?<=\d)\s*\/\s*(?=[A-Za-z])/g, " per ")
    .replace(/&/g, " and ").replace(/[→⇒]/g, " to ").replace(/[≈~]/g, " about ")
    .replace(/[•◦▪▫\uFE0E\uFE0F]|\p{Extended_Pictographic}/gu, " ");
}

export class SentenceChunker {
  private buffer = "";
  constructor(private readonly minLength = 20) {}
  feed(delta: string): string[] {
    this.buffer = this.buffer + delta;
    this.buffer = this.buffer.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, " ");
    this.buffer = this.buffer.replace(/```[\s\S]*?```/g, " ");
    if (/<think(?:\s|>|$)/i.test(this.buffer)) return [];
    const out: string[] = [];
    let start = 0;
    while (start < this.buffer.length) {
      const match = /[.!?。！？]["'”’)]*(?:\s+)|\n\n/.exec(this.buffer.slice(start));
      if (!match) break;
      const end = start + match.index + match[0].length;
      const fence = this.buffer.indexOf("```");
      if (fence >= 0 && fence < end) break;
      const head = this.buffer.slice(0, end);
      if (head.trim().length < this.minLength || /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.["'”’)]*\s*$/i.test(head)) { start = end; continue; }
      out.push(head.trim()); this.buffer = this.buffer.slice(end); start = 0;
    }
    return out;
  }
  flush(): string[] {
    const tail = stripNonspoken(this.buffer).replace(/```[\s\S]*$/g, " ").trim(); this.buffer = "";
    return tail ? [tail] : [];
  }
}

/** No reply is silently cut at 4000 characters: long sentences split at a word boundary. */
export function spokenSentences(text: string): string[] {
  const chunker = new SentenceChunker();
  const sentences = [...chunker.feed(prepareSpokenText(text)), ...chunker.flush()];
  return sentences.flatMap((sentence) => {
    const parts: string[] = [];
    while (sentence.length > 3500) {
      const space = sentence.lastIndexOf(" ", 3500), at = space > 0 ? space : 3500;
      parts.push(sentence.slice(0, at)); sentence = sentence.slice(at).trimStart();
    }
    if (sentence) parts.push(sentence);
    return parts;
  });
}
