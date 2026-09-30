import { inflateRawSync } from "node:zlib";

/**
 * Turning a saved file into plain text for the document library. Word and spreadsheet files are
 * ZIP containers of XML, so a small reader for stored and deflated entries is enough; nothing here
 * runs code from the file or reaches the network. PDFs are reported as needing a helper.
 */
export type DocumentType =
  | "txt" | "md" | "html" | "csv" | "json" | "docx" | "xlsx" | "pdf"
  | "pptx" | "odt" | "ods" | "epub" | "rtf";
const byExtension: Record<string, DocumentType> = {
  txt: "txt", text: "txt", log: "txt", md: "md", markdown: "md", html: "html", htm: "html",
  csv: "csv", tsv: "csv", json: "json", docx: "docx", docm: "docx", xlsx: "xlsx", xlsm: "xlsx", pdf: "pdf",
  pptx: "pptx", pptm: "pptx", odt: "odt", ods: "ods", epub: "epub", rtf: "rtf",
};
/** The kind of file a name points at; anything unknown is read as plain text. */
export function documentType(name: string): DocumentType {
  return byExtension[name.toLowerCase().split(".").pop() ?? ""] ?? "txt";
}
/** Every file ending read as one kind, so a filter can name the kind instead of listing the endings. */
export const extensionsFor = (type: DocumentType): string[] =>
  Object.entries(byExtension).filter(([, value]) => value === type).map(([ending]) => ending);
/** Whether the name ends in an extension this build actually knows, rather than falling back. */
export const knownExtension = (name: string): boolean =>
  byExtension[name.toLowerCase().split(".").pop() ?? ""] !== undefined;

/**
 * How much one zip container may unpack to in total, and how many entries it may list. A small file
 * can be built to unpack into gigabytes; these two caps mean such a file is refused in a moment
 * rather than eating the machine's memory.
 */
export const zipInflatedLimit = 64 * 1024 * 1024;
export const zipEntryLimit = 5000;
export const unpacksTooLarge =
  `This document unpacks to more than ${zipInflatedLimit / 1048576} MB, which is more than can be read at once.`;

export class ZipReader {
  /** How much unpacking this container has left before it is refused. */
  private budget = zipInflatedLimit;
  constructor(private readonly data: Buffer) {}
  private centralDirectory(): number {
    const signature = 0x06054b50;
    for (let pos = this.data.length - 22; pos >= 0; pos--)
      if (this.data.readUInt32LE(pos) === signature) return this.data.readUInt32LE(pos + 16);
    throw new Error("This file is not a readable Word or spreadsheet document");
  }
  /** The bytes of one entry, or null when the container has no such entry. */
  entry(path: string): Buffer | null {
    let pos = this.centralDirectory();
    for (let seen = 0; seen < zipEntryLimit; seen++) {
      if (pos + 46 > this.data.length || this.data.readUInt32LE(pos) !== 0x02014b50) break;
      const nameLength = this.data.readUInt16LE(pos + 28);
      if (pos + 46 + nameLength + this.data.readUInt16LE(pos + 30) + this.data.readUInt16LE(pos + 32) > this.data.length)
        throw new Error("Damaged document directory");
      const name = this.data.toString("utf8", pos + 46, pos + 46 + nameLength);
      if (name === path) return this.read(this.data.readUInt32LE(pos + 42), this.data.readUInt32LE(pos + 20),
        this.data.readUInt32LE(pos + 24), this.data.readUInt16LE(pos + 10), this.data.readUInt16LE(pos + 8));
      pos += 46 + nameLength + this.data.readUInt16LE(pos + 30) + this.data.readUInt16LE(pos + 32);
    }
    return null;
  }
  /** Every entry name in the container, in the order the container lists them. */
  names(): string[] {
    const found: string[] = [];
    let pos = this.centralDirectory();
    while (pos + 46 <= this.data.length && this.data.readUInt32LE(pos) === 0x02014b50) {
      const nameLength = this.data.readUInt16LE(pos + 28);
      found.push(this.data.toString("utf8", pos + 46, pos + 46 + nameLength));
      pos += 46 + nameLength + this.data.readUInt16LE(pos + 30) + this.data.readUInt16LE(pos + 32);
      if (found.length >= zipEntryLimit) break;
    }
    return found;
  }
  /** The text of one entry, or an empty string when the container has no such entry. */
  text(path: string): string {
    return this.entry(path)?.toString("utf8") ?? "";
  }
  /** Sizes and compression come from the central directory, as document-package.ts unpackRaw does.
   * A descriptor-written entry deliberately leaves its local sizes at zero until its data is written. */
  private read(header: number, packedSize: number, unpackedSize: number, method: number, flags: number): Buffer {
    if (header + 30 > this.data.length || this.data.readUInt32LE(header) !== 0x04034b50)
      throw new Error("Damaged document entry");
    if ((flags & 0x41) || (this.data.readUInt16LE(header + 6) & 0x41)) throw new Error("Encrypted document entries cannot be read");
    if (this.data.readUInt16LE(header + 8) !== method || packedSize === 0xffffffff || unpackedSize === 0xffffffff)
      throw new Error("Damaged or unsupported document entry");
    const start = header + 30 + this.data.readUInt16LE(header + 26) + this.data.readUInt16LE(header + 28);
    if (start > this.data.length || packedSize > this.data.length - start) throw new Error("Damaged document entry");
    if (unpackedSize > this.budget) throw new Error(unpacksTooLarge);
    const body = this.data.subarray(start, start + packedSize);
    // The unpacked size is capped as well as checked afterwards, so a part built to unpack into
    // gigabytes stops at the cap instead of being unpacked and only then found to be too big.
    if (method !== 0 && method !== 8) throw new Error("This document uses a compression method the assistant cannot read");
    const bytes = method === 0 ? Buffer.from(body) : this.inflate(body);
    if (bytes.length !== unpackedSize) throw new Error("Damaged document entry size");
    return this.spend(bytes);
  }
  private inflate(body: Buffer): Buffer {
    try { return inflateRawSync(body, { maxOutputLength: this.budget + 1 }); }
    catch (error) {
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new Error(unpacksTooLarge);
      throw new Error("Part of this document is damaged and would not unpack.");
    }
  }
  /** Takes what one part unpacked to out of the container's budget, refusing plainly when it runs out. */
  private spend(bytes: Buffer): Buffer {
    this.budget -= bytes.length;
    if (this.budget < 0) throw new Error(unpacksTooLarge);
    return bytes;
  }
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return codePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#")) return codePoint(parseInt(body.slice(1), 10), whole);
    return entities[body.toLowerCase()] ?? whole;
  });
}
function codePoint(value: number, whole: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
}
/** Runs of spaces become one; tabs and line breaks are kept, because they carry the layout. */
const collapse = (value: string): string => value.replace(/[  ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Readable page text: scripts, styles and comments are dropped, block ends become line breaks. */
export function htmlText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return collapse(decodeEntities(body.replace(/<[^>]*>/g, " ")));
}

export function docxText(buffer: Buffer): string {
  const xml = new ZipReader(buffer).entry("word/document.xml");
  if (!xml) throw new Error("This Word file has no readable document part");
  const body = xml.toString("utf8")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return collapse(decodeEntities(body.replace(/<[^>]*>/g, "")));
}

/** Every `<t>` run inside each shared string, so rich text keeps all of its words. */
export function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    decodeEntities([...(item[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => run[1] ?? "").join("")),
  );
}
/** One line per row, cells separated by tabs; shared, inline and plain values are all kept. */
export function sheetText(xml: string, strings: string[]): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g))
      cells.push(cellText(cell[1] ?? "", cell[2] ?? "", strings));
    if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}
function cellText(attributes: string, body: string, strings: string[]): string {
  const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
  if (type === "inlineStr")
    return decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => run[1] ?? "").join(""));
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (type === "s") return strings[Number(value)] ?? "";
  return decodeEntities(value);
}
export function xlsxText(buffer: Buffer): string {
  const zip = new ZipReader(buffer);
  const shared = zip.entry("xl/sharedStrings.xml");
  const strings = shared ? sharedStrings(shared.toString("utf8")) : [];
  const sheets: string[] = [];
  for (let index = 1; index <= 8; index++) {
    const sheet = zip.entry(`xl/worksheets/sheet${index}.xml`);
    if (!sheet) break;
    const text = sheetText(sheet.toString("utf8"), strings);
    if (text) sheets.push(text);
  }
  if (!sheets.length) throw new Error("This spreadsheet has no readable cells");
  return sheets.join("\n\n");
}

/** Plain text for a saved file. PDFs return null: they need a helper the assistant does not have. */
export function extractText(buffer: Buffer, type: DocumentType): string | null {
  switch (type) {
    case "pdf": return null;
    case "html": return htmlText(buffer.toString("utf8"));
    case "docx": return docxText(buffer);
    case "xlsx": return xlsxText(buffer);
    default: return collapse(buffer.toString("utf8"));
  }
}
