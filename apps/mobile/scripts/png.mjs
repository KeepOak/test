/**
 * Just enough PNG to make the app icons from Branch's mascot without a new dependency: read an
 * 8-bit RGBA (or RGB) picture, scale it, lay it over a colour, and write it back out.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunks(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file");
  const out = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    out.push({ type: file.toString("latin1", at + 4, at + 8), data: file.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
function unfilter(raw, width, height, channels) {
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0, up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const guess = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      pixels[y * stride + x] = (line[x] + guess) & 0xff;
    }
  }
  return pixels;
}

/** { width, height, data: RGBA bytes } from a non-interlaced 8-bit RGB or RGBA PNG. */
export function readPng(file) {
  const parts = chunks(file), header = parts.find((part) => part.type === "IHDR").data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], colour = header[9];
  if (depth !== 8 || ![2, 6].includes(colour) || header[12] !== 0) throw new Error("Only 8-bit RGB/RGBA, non-interlaced PNGs are read");
  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts.filter((part) => part.type === "IDAT").map((part) => part.data)));
  const pixels = unfilter(raw, width, height, channels);
  if (channels === 4) return { width, height, data: pixels };
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) pixels.copy(data, i * 4, i * 3, i * 3 + 3);
  return { width, height, data };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** A PNG from RGBA pixels; `opaque` drops the alpha channel (what an iOS app icon needs). */
export function writePng({ width, height, data }, opaque = false) {
  const channels = opaque ? 3 : 4, stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = data[(y * width + x) * 4 + c];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Box-averaged downscale (the mark is only ever made smaller), weighting colour by alpha. */
export function scale(image, size) {
  const out = Buffer.alloc(size * size * 4), step = image.width / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      let count = 0;
      for (let sy = Math.floor(y * step); sy < Math.min(image.height, Math.ceil((y + 1) * step)); sy++)
        for (let sx = Math.floor(x * step); sx < Math.min(image.width, Math.ceil((x + 1) * step)); sx++) {
          const at = (sy * image.width + sx) * 4, alpha = image.data[at + 3];
          for (let c = 0; c < 3; c++) sum[c] += image.data[at + c] * alpha;
          sum[3] += alpha;
          count++;
        }
      const at = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) out[at + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0;
      out[at + 3] = count ? Math.round(sum[3] / count) : 0;
    }
  return { width: size, height: size, data: out };
}

/** A square canvas of `size`, filled with `background` (#RRGGBB, or null for clear), the mark centred at `fraction`. */
export function compose(mark, size, fraction, background) {
  const inner = Math.round(size * fraction), small = scale(mark, inner), offset = Math.floor((size - inner) / 2);
  const rgb = background ? [1, 3, 5].map((at) => parseInt(background.slice(at, at + 2), 16)) : [0, 0, 0];
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) { data.set(rgb, i * 4); data[i * 4 + 3] = background ? 255 : 0; }
  for (let y = 0; y < inner; y++)
    for (let x = 0; x < inner; x++) {
      const from = (y * inner + x) * 4, to = ((y + offset) * size + x + offset) * 4, alpha = small.data[from + 3] / 255;
      for (let c = 0; c < 3; c++) data[to + c] = Math.round(small.data[from + c] * alpha + data[to + c] * (1 - alpha));
      data[to + 3] = Math.round(255 * alpha + data[to + 3] * (1 - alpha));
    }
  return { width: size, height: size, data };
}

/** The smallest square around what can be seen, so a fraction of the canvas means the mark itself. */
export function trim(image) {
  let top = image.height, left = image.width, bottom = -1, right = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (image.data[(y * image.width + x) * 4 + 3] > 8) {
        top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
      }
  if (bottom < 0) return image;
  const side = Math.max(bottom - top, right - left) + 1;
  const startY = Math.max(0, Math.round((top + bottom - side) / 2)), startX = Math.max(0, Math.round((left + right - side) / 2));
  const data = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const sy = startY + y, sx = startX + x;
      if (sy < image.height && sx < image.width) image.data.copy(data, (y * side + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4);
    }
  return { width: side, height: side, data };
}
