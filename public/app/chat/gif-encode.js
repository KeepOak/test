/* GIF header/frame/control layout adapted from gifenc src/index.js (MIT),
 * Copyright (c) 2017 Matt DesLauriers. Full notice: LICENSE.gif-encode.
 * Palette conversion and bounded clear-code LZW are original. No external runtime or encoder dependency. */
const MAX_BYTES = 2 * 1024 * 1024;
function stream() {
  const bytes = new Uint8Array(MAX_BYTES); let at = 0;
  const byte = value => { if (at >= bytes.length) throw new Error("GIF limit"); bytes[at++] = value; };
  return { byte, bytes: values => { for (const value of values) byte(value); },
    short: value => { byte(value & 255); byte(value >>> 8 & 255); },
    text: value => { for (const letter of value) byte(letter.charCodeAt(0)); },
    finish: () => bytes.slice(0, at) };
}
function header(out, width, height) {
  out.text("GIF89a"); out.short(width); out.short(height); out.bytes([0xf7, 0, 0]);
  for (let index = 0; index < 256; index++) out.bytes([
    Math.round((index >>> 5) * 255 / 7), Math.round((index >>> 2 & 7) * 255 / 7), Math.round((index & 3) * 255 / 3),
  ]);
  out.bytes([0x21, 0xff, 11]); out.text("NETSCAPE2.0"); out.bytes([3, 1, 0, 0, 0]);
}
/** Clear before the dictionary can exceed nine bits. Larger output buys a small, bounded encoder. */
function pixels(out, indices) {
  out.byte(8);
  const block = new Uint8Array(255); let count = 0, bits = 0, pending = 0;
  const flush = () => { if (count) { out.byte(count); out.bytes(block.subarray(0, count)); count = 0; } };
  const byte = value => { block[count++] = value; if (count === 255) flush(); };
  const code = value => {
    pending |= value << bits; bits += 9;
    while (bits >= 8) { byte(pending & 255); pending >>>= 8; bits -= 8; }
  };
  for (let at = 0; at < indices.length; at += 240) {
    code(256);
    for (let end = Math.min(at + 240, indices.length), i = at; i < end; i++) code(indices[i]);
  }
  code(257); if (bits) byte(pending & 255); flush(); out.byte(0);
}
export function gifBytes(frames, width = 320, height = 240) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 320 || height > 240
    || !Array.isArray(frames) || frames.length < 2 || frames.length > 20) throw new Error("GIF frames unavailable");
  const out = stream(); header(out, width, height);
  for (const frame of frames) {
    if (!(frame instanceof Uint8Array) || frame.length !== width * height) throw new Error("Invalid GIF frame");
    out.bytes([0x21, 0xf9, 4, 4]); out.short(50); out.bytes([0, 0]);
    out.byte(0x2c); out.short(0); out.short(0); out.short(width); out.short(height); out.byte(0);
    pixels(out, frame);
  }
  out.byte(0x3b); return out.finish();
}
export function gifPalette(rgba) {
  const indices = new Uint8Array(rgba.length / 4);
  for (let at = 0; at < indices.length; at++) {
    const i = at * 4;
    indices[at] = Math.round(rgba[i] * 7 / 255) << 5 | Math.round(rgba[i + 1] * 7 / 255) << 2 | Math.round(rgba[i + 2] * 3 / 255);
  }
  return indices;
}
