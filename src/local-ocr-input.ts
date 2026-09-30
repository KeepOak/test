import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Bounded read from the already checked workspace path, using the opened file's metadata. */
export async function ocrInput(path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > limit) throw new Error("OCR input is not a regular file without hardlinks within its size limit");
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let used = 0;
    while (used < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used > info.size || used > limit) throw new Error("OCR input changed while it was read");
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}

/** Checks dimensions before a native decoder sees the image; only single PNG/JPEG images are accepted. */
export function checkOcrPixels(bytes: Buffer): void {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    if (bytes.includes(Buffer.from("acTL"))) throw new Error("Animated PNG is not supported for local OCR");
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++]!;
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (at + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([192, 193, 194].includes(marker) && size >= 8) {
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += size;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304)
    throw new Error("OCR accepts PNG/JPEG images up to 4 megapixels and 4096 pixels per side");
}
