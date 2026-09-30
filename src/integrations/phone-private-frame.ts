import type { PrivateDesktops } from './private-desktops.js';
import { openPrivateRfb, type PrivateRfbStream } from './private-rfb-stream.js';
const active = new Set<string>();
function phonePixels(pixels: Buffer, width: number, height: number) {
  const scale = Math.min(1, 640 / width, 400 / height);
  const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  const small = Buffer.alloc(w * h * 4);
  try {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const source = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
      pixels.copy(small, (y * w + x) * 4, source, source + 4);
    }
    return { width: w, height: h, pixels: small.toString('base64'), format: 'rgbx' as const };
  } finally { small.fill(0); }
}

/** One bounded full frame from an already-running private desktop. No input API is exposed. */
export async function phonePrivateFrame(desktops: PrivateDesktops, owner: string, trunk: string, valid: () => boolean) {
  const scope = JSON.stringify([owner, trunk]);
  if (active.has(scope) || active.size >= 2) throw new Error('Another private phone frame is being read. Wait before refreshing.');
  active.add(scope);
  const abort = new AbortController();
  let stream: PrivateRfbStream | undefined, width = 0, height = 0, count = 0;
  let pixels = Buffer.alloc(0), covered = new Uint8Array(0), complete = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const frame = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void frame.catch(() => undefined); // Transport setup may still be awaiting when cancellation arrives.
  const stop = () => { abort.abort(); stream?.close(); reject(new Error('Private phone view ended.')); };
  const clock = setInterval(() => { if (!valid()) stop(); }, 250); clock.unref();
  const timeout = setTimeout(stop, 5000); timeout.unref();
  const unsubscribe = desktops.onInvalidate((changedOwner, agent) => { if (owner === changedOwner && trunk === agent) stop(); });
  try {
    if (!valid()) throw new Error('Private phone view refused.');
    const target = await desktops.viewerTarget(owner, trunk);
    if (!valid()) throw new Error('Private phone view ended.');
    stream = await openPrivateRfb(target, valid, (w, h) => {
      width = w; height = h; pixels = Buffer.alloc(w * h * 4); covered = new Uint8Array(w * h);
    }, bytes => {
      if (!valid() || complete) return;
      const x = bytes.readUInt16BE(0), y = bytes.readUInt16BE(2), w = bytes.readUInt16BE(4), h = bytes.readUInt16BE(6);
      if (!w || !h || x + w > width || y + h > height || bytes.length !== 8 + w * h * 4) return stop();
      for (let row = 0; row < h; row++) {
        const at = (y + row) * width + x;
        bytes.copy(pixels, at * 4, 8 + row * w * 4, 8 + (row + 1) * w * 4);
        for (let col = 0; col < w; col++) if (!covered[at + col]) { covered[at + col] = 1; count++; }
      }
      if (count === width * height) { complete = true; resolve(); }
    }, () => { if (!complete) stop(); }, abort.signal);
    await frame;
    if (!valid()) throw new Error('Private phone view ended.');
    return phonePixels(pixels, width, height);
  } finally {
    active.delete(scope); clearInterval(clock); clearTimeout(timeout); unsubscribe(); abort.abort(); stream?.close(); pixels.fill(0); covered.fill(0);
  }
}
