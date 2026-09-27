import { crc32, deflateRawSync } from "node:zlib";

/**
 * A plain .zip writer (deflate, no encryption, no zip64), enough for Settings › Your data's export: every entry is
 * held in memory, so the caller keeps the whole archive under 4 GiB (it is refused long before that).
 */
export interface ZipEntry { name: string; data: Buffer }

const dosTime = (at: Date): { time: number; date: number } => ({
  time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
  date: ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
});

/** A safe name inside the archive: forward slashes, no drive, no "..", no leading slash. */
export function zipName(name: string): string {
  const parts = name.replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== "..");
  const joined = parts.map((part) => part.replace(/[\u0000-\u001f:*?"<>|]/g, "_")).join("/");
  if (!joined) throw new Error("A file in the export needs a name");
  return joined;
}

function header(signature: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  out.writeUInt32LE(signature, 0);
  return out;
}

/** Builds the archive from its entries, in order. */
export function buildZip(entries: readonly ZipEntry[], at = new Date()): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(zipName(entry.name), "utf8");
    const packed = deflateRawSync(entry.data), crc = crc32(entry.data);
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = header(0x02014b50, 46);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = header(0x06054b50, 22);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
