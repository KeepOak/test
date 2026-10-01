import { inflateSync } from "node:zlib";
import { pdfEncoding, pdfGlyphText } from "./pdf-font-encodings.js";

/**
 * Reading the words out of a PDF without asking anything else to help. A PDF is a bag of numbered
 * objects; the pages point at streams of drawing instructions, and the instructions that draw text
 * say which piece of text goes where. This finds the objects, unpacks the compressed ones, follows
 * the page tree, and turns each page's drawing instructions back into lines by where they sat on
 * the page. Nothing in the file is executed and no address inside it is ever fetched.
 *
 * What it cannot do is said plainly rather than guessed at: a PDF locked with a password is
 * refused, a PDF that is pictures of text reports that it is pictures, and a stream packed in a way
 * this reader does not unpack is listed as a part that could not be read.
 */
export class PdfLocked extends Error {}
export interface PdfPage { page: number; text: string }
export interface PdfText {
  pages: PdfPage[];
  /** True when the file has pages but none of them draw any text: it is pictures of text. */
  pictures: boolean;
  /** Parts that could not be read, in plain language, for the "what could not be read" list. */
  limits: string[];
}
/** How much of one PDF is worth walking; a larger file is read this far and says it was cut short. */
export const pdfByteLimit = 24 * 1024 * 1024;
const maxPages = 500;
const maxObjects = 20000;
/**
 * How much one PDF may unpack to in total. A few hundred kilobytes of file can be built to unpack
 * into gigabytes, so the budget is spent down as streams are opened and the file is refused plainly
 * once it runs out, rather than the machine running out of memory first.
 */
export const pdfInflatedLimit = 64 * 1024 * 1024;
export const pdfUnpacksTooLarge =
  `This PDF unpacks to more than ${pdfInflatedLimit / 1048576} MB, which is more than can be read at once.`;
/** How many pieces of one page's drawing instructions are read before the rest is left. */
const maxTokensPerPage = 2_000_000;
interface Budget { left: number }

interface RawObject { number: number; body: Buffer; stream: Buffer | null }

/** Latin-1 view of a slice, which is how PDF names and keywords are written. */
const latin = (bytes: Buffer): string => bytes.toString("latin1");

/**
 * Every `N G obj … endobj` in the file, found by scanning rather than by trusting the cross
 * reference table, so a file whose table is damaged or written in the newer packed form still
 * reads. Objects held inside a packed object stream are unpacked afterwards.
 */
function scanObjects(data: Buffer): Map<number, RawObject> {
  const found = new Map<number, RawObject>();
  const text = latin(data);
  const header = /(\d{1,9})\s+(\d{1,5})\s+obj\b/g;
  for (let match = header.exec(text); match && found.size < maxObjects; match = header.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) continue;
    const body = data.subarray(start, end);
    found.set(Number(match[1]), { number: Number(match[1]), body, stream: streamOf(data, text, start, end) });
  }
  return found;
}
/** The bytes between `stream` and `endstream`, kept raw; unpacking happens when they are used. */
function streamOf(data: Buffer, text: string, start: number, end: number): Buffer | null {
  const at = text.indexOf("stream", start);
  if (at < 0 || at > end) return null;
  let from = at + 6;
  if (text[from] === "\r") from++;
  if (text[from] === "\n") from++;
  const stop = text.indexOf("endstream", from);
  return stop < 0 || stop > end + 16 ? null : data.subarray(from, stop);
}

/** A dictionary entry's raw text, for simple values: `/Key value` up to the next key or bracket. */
export function dictValue(dictionary: string, key: string): string | null {
  const at = dictionary.indexOf(`/${key}`);
  if (at < 0) return null;
  const rest = dictionary.slice(at + key.length + 1);
  const value = /^\s*(\[[^\]]*\]|<<[\s\S]*?>>|\/[^\s/<>[\]()]+|[-\d.]+\s+\d+\s+R|[-\d.]+|\([^)]*\))/.exec(rest);
  return value ? value[1]!.trim() : null;
}
/** The object number a `12 0 R` reference points at, or null when the value is not a reference. */
const referenceNumber = (value: string | null): number | null => {
  const match = value ? /^(\d+)\s+\d+\s+R$/.exec(value) : null;
  return match ? Number(match[1]) : null;
};

/**
 * Unpacks one stream. Only the packing this reader understands is unpacked; the rest is refused.
 * Every stream is taken out of the file's unpacking budget, so a file built to unpack into
 * gigabytes stops at the budget instead of filling the machine's memory.
 */
function unpack(object: RawObject, budget: Budget): { bytes: Buffer | null; limit: string } {
  if (!object.stream) return { bytes: null, limit: "" };
  const filter = dictValue(latin(object.body), "Filter") ?? "";
  if (!filter || filter === "[]") return spend(object.stream, budget);
  if (!filter.includes("FlateDecode"))
    return { bytes: null, limit: `Part of this PDF is packed as ${filter.replace(/[/[\]]/g, "")}, which this reader does not unpack.` };
  if (budget.left <= 0) return { bytes: null, limit: pdfUnpacksTooLarge };
  try { return spend(inflateSync(object.stream, { maxOutputLength: budget.left + 1 }), budget); }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return { bytes: null, limit: pdfUnpacksTooLarge };
    return { bytes: null, limit: "Part of this PDF is packed in a way that would not unpack." };
  }
}
/** What one stream came to, taken out of the file's budget; nothing more is opened once it is gone. */
function spend(bytes: Buffer, budget: Budget): { bytes: Buffer | null; limit: string } {
  budget.left -= bytes.length;
  return budget.left < 0 ? { bytes: null, limit: pdfUnpacksTooLarge } : { bytes, limit: "" };
}

/** Objects that were packed inside another object, added to the set under their own numbers. */
function expandPacked(objects: Map<number, RawObject>, budget: Budget): string[] {
  const limits: string[] = [];
  for (const object of [...objects.values()]) {
    const dictionary = latin(object.body);
    if (!dictionary.includes("/ObjStm")) continue;
    const { bytes, limit } = unpack(object, budget);
    if (limit) limits.push(limit);
    if (!bytes) continue;
    const count = Number(dictValue(dictionary, "N") ?? 0), first = Number(dictValue(dictionary, "First") ?? 0);
    const header = latin(bytes.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let index = 0; index < Math.min(count, 5000); index++) {
      const number = header[index * 2], offset = header[index * 2 + 1];
      if (number === undefined || offset === undefined || objects.has(number)) continue;
      const next = header[index * 2 + 3];
      objects.set(number, { number, body: bytes.subarray(first + offset, first + (next ?? bytes.length - first)), stream: null });
    }
  }
  return [...new Set(limits)];
}

/** The page objects in reading order, walked down from the catalogue's page tree. */
function pagesInOrder(objects: Map<number, RawObject>): RawObject[] {
  const root = [...objects.values()].find((object) => latin(object.body).includes("/Type") && latin(object.body).includes("/Catalog"));
  const top = root ? referenceNumber(dictValue(latin(root.body), "Pages")) : null;
  const ordered: RawObject[] = [];
  if (top !== null) walkPages(objects, top, ordered, new Set(), 0);
  if (ordered.length) return ordered.slice(0, maxPages);
  return [...objects.values()]
    .filter((object) => /\/Type\s*\/Page[^s]/.test(latin(object.body)))
    .sort((a, b) => a.number - b.number).slice(0, maxPages);
}
function walkPages(objects: Map<number, RawObject>, number: number, into: RawObject[], seen: Set<number>, depth: number): void {
  if (depth > 32 || seen.has(number) || into.length >= maxPages) return;
  seen.add(number);
  const object = objects.get(number);
  if (!object) return;
  const dictionary = latin(object.body);
  if (/\/Type\s*\/Page[^s]/.test(dictionary)) { into.push(object); return; }
  for (const kid of (dictValue(dictionary, "Kids") ?? "").matchAll(/(\d+)\s+\d+\s+R/g))
    walkPages(objects, Number(kid[1]), into, seen, depth + 1);
}

/** Every content stream of one page, joined, so the drawing instructions can be read in order. */
function pageContent(objects: Map<number, RawObject>, page: RawObject, limits: string[], budget: Budget): string {
  const value = dictValue(latin(page.body), "Contents") ?? "";
  const parts: string[] = [];
  for (const reference of value.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const target = objects.get(Number(reference[1]));
    if (!target) continue;
    const { bytes, limit } = unpack(target, budget);
    if (limit && !limits.includes(limit)) limits.push(limit);
    if (bytes) parts.push(latin(bytes));
  }
  return parts.join("\n");
}

/**
 * A page's fonts and, for each, the table that turns the numbers in a drawn string back into
 * letters. Only the tables written into the file itself are used; nothing is looked up elsewhere.
 */
function pageFonts(objects: Map<number, RawObject>, page: RawObject, budget: Budget, limits: string[]): Map<string, Map<number, string>> {
  const fonts = new Map<string, Map<number, string>>();
  const resources = resourceDictionary(objects, page);
  const fontBlock = dictValue(resources, "Font") ?? "";
  const inline = fontBlock.startsWith("<<") ? fontBlock : latin(objects.get(referenceNumber(fontBlock) ?? -1)?.body ?? Buffer.alloc(0));
  for (const entry of inline.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objects.get(Number(entry[2]));
    if (!font) continue;
    const unicode = referenceNumber(dictValue(latin(font.body), "ToUnicode"));
    const source = unicode === null ? null : objects.get(unicode);
    const unicodeMap = source ? parseCmap(latin(unpack(source, budget).bytes ?? Buffer.alloc(0))) : null;
    const encoded = fontEncoding(objects, font, limits);
    if (encoded && unicodeMap) for (const [code, text] of encoded) if (!unicodeMap.has(code)) unicodeMap.set(code, text);
    fonts.set(entry[1]!, unicodeMap ?? encoded ?? new Map());
  }
  return fonts;
}
/** Simple font encodings stay byte-wide; a ToUnicode map always wins over a named glyph. */
function fontEncoding(objects: Map<number, RawObject>, font: RawObject, limits: string[]): Map<number, string> | null {
  const dictionary = latin(font.body);
  if (dictValue(dictionary, "Subtype") === "/Type0") return null;
  const raw = dictValue(dictionary, "Encoding");
  if (!raw) return null;
  const ref = referenceNumber(raw);
  const encoding = (ref === null ? raw : latin(objects.get(ref)?.body ?? Buffer.alloc(0))).trim();
  const base = encoding.startsWith("/") ? encoding.slice(1) : (dictValue(encoding, "BaseEncoding") ?? "/StandardEncoding").slice(1);
  const names = pdfEncoding(base), map = parseCmap("1 begincodespacerange <00> <ff> endcodespacerange");
  const note = (message: string) => { if (!limits.includes(message)) limits.push(message); };
  if (!names) note("A PDF font uses an unsupported base encoding; unmapped characters could not be read.");
  for (let code = 0; code < 256; code++) map.set(code, names?.[code] ? pdfGlyphText(names[code]!, base === "ZapfDingbatsEncoding") ?? "�" : "�");
  const value = dictValue(encoding, "Differences");
  if (value) applyDifferences(value, objects, map, base === "ZapfDingbatsEncoding", note);
  return map;
}
/** Adapted PDF.js evaluator Differences iteration: numbers set a byte index; following names advance it. */
function applyDifferences(value: string, objects: Map<number, RawObject>, map: Map<number, string>, dingbat: boolean, note: (message: string) => void): void {
  const tokens = [...pdfTokens(value, 1024)];
  if (tokens.length >= 1024) note("A PDF font Differences array exceeded the reader limit.");
  let code = 0;
  for (let at = 0; at < tokens.length; at++) {
    let token = tokens[at]!;
    const generation = tokens[at + 1], marker = tokens[at + 2];
    if (token.kind === "number" && generation?.kind === "number" && marker?.kind === "op" && marker.text === "R") {
      const object = objects.get(token.value);
      const resolved = object ? [...pdfTokens(latin(object.body), 2)] : [];
      if (resolved.length !== 1) { note("A PDF font has an invalid indirect Differences entry."); code = -1; at += 2; continue; }
      token = resolved[0]!; at += 2;
    }
    if (token.kind === "number") {
      code = Number.isInteger(token.value) && token.value >= 0 && token.value <= 255 ? token.value : -1;
      if (code < 0) note("A PDF font Differences index is outside its byte range.");
      continue;
    }
    if (token.kind !== "name" || code < 0 || code > 255) { note("A PDF font has an invalid Differences entry."); continue; }
    const name = token.text.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const text = pdfGlyphText(name, dingbat);
    if (text === null) note("Some PDF font glyph names could not be converted to text.");
    map.set(code++, text ?? "�");
  }
}
function resourceDictionary(objects: Map<number, RawObject>, page: RawObject): string {
  const seen = new Set<number>();
  let current: RawObject | undefined = page;
  for (let depth = 0; current && depth < 32 && !seen.has(current.number); depth++) {
    seen.add(current.number);
    const dictionary = latin(current.body), value = dictValue(dictionary, "Resources");
    if (value !== null) {
      if (value.startsWith("<<")) return value;
      return latin(objects.get(referenceNumber(value) ?? -1)?.body ?? Buffer.alloc(0));
    }
    current = objects.get(referenceNumber(dictValue(dictionary, "Parent")) ?? -1);
  }
  return "";
}

interface CodeSpace { width: number; from: number; to: number }
const codeSpaces = new WeakMap<Map<number, string>, Map<number, CodeSpace[]>>();
/** The `bfchar` and `bfrange` entries of a ToUnicode table: which number means which letter. */
export function parseCmap(text: string): Map<number, string> {
  const map = new Map<number, string>(), spaces: CodeSpace[] = [], inferred: CodeSpace[] = [];
  const range = (low: string, high: string): CodeSpace => ({ width: low.length / 2, from: parseInt(low, 16), to: parseInt(high, 16) });
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const row of block[1]!.matchAll(/<([0-9a-fA-F]{2,8})>\s*<([0-9a-fA-F]{2,8})>/g)) {
      if (row[1]!.length % 2 === 0 && row[1]!.length === row[2]!.length) spaces.push(range(row[1]!, row[2]!));
    }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]{2,8})>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), hexToText(pair[2]!));
      inferred.push(range(pair[1]!, pair[1]!));
    }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const row of block[1]!.matchAll(/<([0-9a-fA-F]{2,8})>\s*<([0-9a-fA-F]{2,8})>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const { from, to } = range(row[1]!, row[2]!);
      inferred.push(range(row[1]!, row[2]!));
      const array = row[5] === undefined ? null : [...row[5].matchAll(/<([0-9a-fA-F]+)>/g)].map(item => item[1]!);
      const destination = row[4] ? Buffer.from(row[4], "hex") : null;
      for (let code = from; code <= to && code - from < 1024; code++) {
        const value = array ? array[code - from] : destination?.toString("hex");
        if (value === undefined) break;
        map.set(code, hexToText(value));
        if (destination) incrementDestination(destination);
      }
    }
  codeSpaces.set(map, indexedSpaces(spaces.length ? spaces : inferred));
  return map;
}
/** Merge ranges by byte width so decoding does not scan every mapping for every character. */
function indexedSpaces(spaces: CodeSpace[]): Map<number, CodeSpace[]> {
  const index = new Map<number, CodeSpace[]>();
  for (const space of spaces.sort((a, b) => a.width - b.width || a.from - b.from)) {
    if (!Number.isInteger(space.width) || space.width < 1 || space.width > 4 || space.to < space.from) continue;
    const ranges = index.get(space.width) ?? [], last = ranges.at(-1);
    if (last && space.from <= last.to + 1) last.to = Math.max(last.to, space.to);
    else ranges.push({ ...space });
    index.set(space.width, ranges);
  }
  return index;
}
function containsCode(ranges: CodeSpace[], code: number): boolean {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, range = ranges[middle]!;
    if (code < range.from) high = middle - 1;
    else if (code > range.to) low = middle + 1;
    else return true;
  }
  return false;
}
/** Adapted from pdf.js CMap.mapBfRange (Apache-2.0): increment bytes, not a Unicode scalar.
 * Multi-unit UTF-16 destinations remain strings, so a ligature cannot throw fromCodePoint. */
function incrementDestination(destination: Buffer): void {
  for (let at = destination.length - 1; at >= 0; at--) {
    destination[at] = (destination[at]! + 1) & 0xff;
    if (destination[at] !== 0) break;
  }
}
const hexToText = (hex: string): string => {
  let out = "";
  for (let at = 0; at + 3 < hex.length + 1; at += 4) out += String.fromCharCode(parseInt(hex.slice(at, at + 4), 16));
  return out;
};

interface Piece { y: number; x: number; text: string }
/** One piece of a content stream: a string to draw, a number, a name, or an instruction. */
export type PdfToken =
  | { kind: "string" | "hex" | "name" | "op"; text: string }
  | { kind: "number"; value: number };
const isSpace = (character: string): boolean => character <= " ";
const isDelimiter = (character: string): boolean => isSpace(character) || "()<>[]{}/%".includes(character);

/**
 * The pieces of a content stream, read left to right in one pass. Reading it this way rather than
 * with one big pattern matters: a pattern that has to decide how a run of numbers divides up can
 * take minutes on a page built to be awkward, and a file the owner merely opened must never be able
 * to hold the assistant up. Strings are taken whole here, so an instruction written inside one is
 * never mistaken for a real instruction.
 */
export function* pdfTokens(content: string, limit = maxTokensPerPage): Generator<PdfToken> {
  let at = 0;
  for (let count = 0; at < content.length && count < limit; count++) {
    const character = content[at]!;
    if (isSpace(character)) { at++; count--; continue; }
    if (character === "%") { const end = content.indexOf("\n", at); at = end < 0 ? content.length : end + 1; continue; }
    if (character === "(") { const found = literal(content, at + 1); at = found.next; yield { kind: "string", text: found.text }; continue; }
    if (character === "<" && content[at + 1] !== "<") {
      const end = content.indexOf(">", at + 1);
      yield { kind: "hex", text: content.slice(at + 1, end < 0 ? content.length : end) };
      at = end < 0 ? content.length : end + 1; continue;
    }
    if ("<>[]{}".includes(character)) { at += content[at] === content[at + 1] ? 2 : 1; continue; }
    const word = wordAt(content, character === "/" ? at + 1 : at);
    at = character === "/" ? word.next : Math.max(word.next, at + 1);
    if (character === "/") { yield { kind: "name", text: word.text }; continue; }
    if (/^[-+.\d]/.test(word.text)) yield { kind: "number", value: Number(word.text) || 0 };
    else if (word.text) yield { kind: "op", text: word.text };
  }
}
/** A literal string, taken whole with its nesting and its escapes left as they were written. */
function literal(content: string, from: number): { text: string; next: number } {
  let text = "", depth = 1, at = from;
  while (at < content.length) {
    const character = content[at]!;
    if (character === "\\") { text += character + (content[at + 1] ?? ""); at += 2; continue; }
    if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return { text, next: at + 1 };
    text += character; at++;
  }
  return { text, next: at };
}
const wordAt = (content: string, from: number): { text: string; next: number } => {
  let end = from;
  while (end < content.length && !isDelimiter(content[end]!)) end++;
  return { text: content.slice(from, end), next: end };
};

interface TextState { x: number; y: number; lineX: number; lineY: number; font: Map<number, string> }
/**
 * The drawing instructions of one page turned back into lines. Text is placed by the position the
 * instructions set, so pieces that share a line come back on one line, in the order they sit.
 */
export function readContent(content: string, fonts: Map<string, Map<number, string>>): string {
  const pieces: Piece[] = [];
  const state: TextState = { x: 0, y: 0, lineX: 0, lineY: 0, font: new Map() };
  let operands: PdfToken[] = [];
  for (const token of pdfTokens(content)) {
    if (token.kind !== "op") { if (operands.length < 64) operands.push(token); continue; }
    apply(token.text, operands, state, fonts, pieces);
    operands = [];
  }
  return joinLines(pieces);
}
/** What one instruction does: move the pen, change the font, or put letters on the page. */
function apply(
  operator: string, operands: PdfToken[], state: TextState,
  fonts: Map<string, Map<number, string>>, pieces: Piece[],
): void {
  const numbers = operands.flatMap((token) => (token.kind === "number" ? [token.value] : []));
  if (operator === "Tf") { state.font = fonts.get(lastName(operands)) ?? new Map(); return; }
  if (operator === "BT") { state.x = state.y = state.lineX = state.lineY = 0; return; }
  if (operator === "Td" || operator === "TD") {
    state.lineX += numbers.at(-2) ?? 0; state.lineY += numbers.at(-1) ?? 0; return newLine(state);
  }
  if (operator === "Tm") { state.lineX = numbers.at(-2) ?? 0; state.lineY = numbers.at(-1) ?? 0; return newLine(state); }
  if (operator === "T*") { state.lineY -= 12; return newLine(state); }
  if (!["TJ", "Tj", "'", '"'].includes(operator)) return;
  if (operator === "'" || operator === '"') { state.lineY -= 12; newLine(state); }
  const text = drawnText(operands, state.font, operator === "TJ");
  if (!text) return;
  pieces.push({ y: state.y, x: state.x, text });
  state.x += text.length;
}
const newLine = (state: TextState): void => { state.x = state.lineX; state.y = state.lineY; };
const lastName = (operands: PdfToken[]): string =>
  operands.flatMap((token) => (token.kind === "name" ? [token.text] : [])).at(-1) ?? "";
/** The letters one drawing instruction puts on the page, from its literal and hex strings. */
function drawnText(operands: PdfToken[], font: Map<number, string>, spacedArray: boolean): string {
  let out = "";
  let gap = false;
  for (const token of operands) {
    // pdf.js SPACE_IN_FLOW_MIN_FACTOR (0.102), adapted to TJ's thousandths of the font size.
    if (token.kind === "number" && spacedArray) { if (token.value <= -102) gap = true; continue; }
    let text = "";
    if (token.kind === "string") {
      const bytes = unescapeLiteral(token.text);
      text = font.size ? mapCodes(hexCodes(Buffer.from(bytes, "latin1").toString("hex"), font), font) : bytes;
    } else if (token.kind === "hex") text = mapCodes(hexCodes(token.text, font), font);
    if (!text) continue;
    if (gap && out && !/\s$/.test(out) && !/^\s/.test(text)) out += " ";
    out += text; gap = false;
  }
  return out;
}
/** Adapted from pdf.js CMap.readCharCode (Apache-2.0): match declared ranges, up to four bytes. */
const hexCodes = (hex: string, font: Map<number, string>): number[] => {
  const clean = hex.replace(/\s+/g, ""), spaces = codeSpaces.get(font);
  const codes: number[] = [];
  for (let at = 0; at < clean.length;) {
    let width = 2, code = parseInt(clean.slice(at, at + 2).padEnd(2, "0"), 16);
    for (let bytes = 1; bytes <= 4 && at + bytes * 2 <= clean.length; bytes++) {
      const candidate = parseInt(clean.slice(at, at + bytes * 2), 16);
      if (containsCode(spaces?.get(bytes) ?? [], candidate)) {
        width = bytes * 2; code = candidate; break;
      }
    }
    codes.push(code); at += width;
  }
  return codes;
};
/** A table entry where the file gave one, otherwise the number read as ordinary Latin text. */
const mapCodes = (codes: number[], font: Map<number, string>): string =>
  codes.map((code) => font.get(code) ?? (code >= 32 ? String.fromCharCode(code) : "")).join("");
/** `\n`, `\(` and `\101` inside a literal string, turned back into what they stand for. */
export function unescapeLiteral(value: string): string {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return value.replace(/\\(\d{1,3}|.)/gs, (_whole, body: string) =>
    /^\d+$/.test(body) ? String.fromCharCode(parseInt(body, 8)) : escapes[body] ?? body);
}
/** Pieces that sit at the same height become one line, top of the page first. */
function joinLines(pieces: Piece[]): string {
  const rows = new Map<number, Piece[]>();
  for (const piece of pieces) {
    const key = Math.round(piece.y);
    rows.set(key, [...(rows.get(key) ?? []), piece]);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((piece) => piece.text).join("").replace(/\s+$/, ""))
    .filter((line) => line.trim()).join("\n");
}

/**
 * The words of a PDF, page by page. A file locked with a password is refused outright; a file whose
 * pages draw no text at all comes back marked as pictures so the caller can offer to look at it.
 */
export function pdfText(bytes: Buffer, deadline = Infinity): PdfText {
  if (bytes.length > pdfByteLimit) throw new Error(`PDFs up to ${pdfByteLimit / 1048576} MB can be read`);
  if (!latin(bytes.subarray(0, 1024)).includes("%PDF")) throw new Error("That file is not a PDF");
  const budget: Budget = { left: pdfInflatedLimit };
  const objects = scanObjects(bytes);
  const limits = expandPacked(objects, budget);
  if ([...objects.values()].some((object) => latin(object.body).includes("/Encrypt"))
    || /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin(bytes.subarray(-4096))))
    throw new PdfLocked("This PDF is locked with a password, so its words cannot be read. Open it with the password and save an unlocked copy first.");
  const found = pagesInOrder(objects);
  if (!found.length) throw new Error("No pages could be found in this PDF, so there is nothing to read.");
  const pages: PdfPage[] = [];
  for (const [index, page] of found.entries()) {
    // Checked before each page rather than only at the end, so a long file stops at the time it was
    // given and says which pages it got to instead of holding everything else up.
    if (Date.now() > deadline) { limits.push(readingStopped(index, found.length)); break; }
    pages.push({ page: index + 1, text: readContent(pageContent(objects, page, limits, budget), pageFonts(objects, page, budget, limits)) });
  }
  return { pages, pictures: pages.length > 0 && pages.every((page) => !page.text.trim()), limits };
}
const readingStopped = (done: number, total: number): string =>
  `This PDF took longer to read than the time allowed, so only the first ${done} of its ${total} pages were read.`;
/** The whole file as text, with the page markers the passage-cutter already understands. */
export function pdfMarkedText(result: PdfText): string {
  return result.pages.map((page) => `[[page ${page.page}]]\n${page.text}`).join("\n\n").trim();
}
