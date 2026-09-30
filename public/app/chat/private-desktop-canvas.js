/* Original bounded Raw RFB rendering/input adapter. Authentication remains entirely in the engine.
   No clipboard, uploads, URLs, password fields, extensions, dynamic resizing or host input. */
const KEYS = {Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Insert: 0xff63, Delete: 0xffff,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, ArrowLeft: 0xff51, ArrowUp: 0xff52,
  ArrowRight: 0xff53, ArrowDown: 0xff54, Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb};
const keyOf = event => KEYS[event.key] ?? (/^F([1-9]|1[0-2])$/.test(event.key) ? 0xffbd + Number(event.key.slice(1)) :
  [...event.key].length === 1 ? (event.key.codePointAt(0) <= 255 ? event.key.codePointAt(0) : 0x01000000 | event.key.codePointAt(0)) : null);

function canvasInput(canvas, send, enabled) {
  const events = new AbortController(), held = new Map();
  let last = [0, 0], movedAt = 0;
  const key = (symbol, down) => { const bytes = new Uint8Array(8); bytes[0] = 4; bytes[1] = +down; new DataView(bytes.buffer).setUint32(4, symbol); send(bytes); };
  const pointer = (x, y, buttons) => {
    const bytes = new Uint8Array(6), view = new DataView(bytes.buffer); bytes[0] = 5; bytes[1] = buttons;
    view.setUint16(2, x); view.setUint16(4, y); send(bytes); last = [x, y];
  };
  const release = () => { if (enabled()) { for (const symbol of held.values()) key(symbol, false); pointer(...last, 0); } held.clear(); };
  canvas.addEventListener('keydown', event => {
    if (!enabled()) return;
    const symbol = keyOf(event); if (symbol === null) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat && held.size < 32) { held.set(event.code, symbol); key(symbol, true); }
  }, {signal: events.signal});
  canvas.addEventListener('keyup', event => {
    if (!enabled() || !held.has(event.code)) return;
    event.preventDefault(); event.stopPropagation(); key(held.get(event.code), false); held.delete(event.code);
  }, {signal: events.signal});
  const point = event => {
    if (!enabled()) return;
    if (event.type === 'pointermove' && performance.now() - movedAt < 33) return;
    movedAt = performance.now();
    const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)));
    const buttons = (event.buttons & 1) | ((event.buttons & 4) >> 1) | ((event.buttons & 2) << 1);
    if (event.type === 'pointerdown') { canvas.focus(); canvas.setPointerCapture(event.pointerId); }
    event.preventDefault(); event.stopPropagation(); pointer(x, y, buttons);
  };
  for (const name of ['pointerdown', 'pointerup', 'pointermove']) canvas.addEventListener(name, point, {signal: events.signal});
  canvas.addEventListener('pointercancel', release, {signal: events.signal});
  canvas.addEventListener('blur', release, {signal: events.signal});
  canvas.addEventListener('contextmenu', event => { if (enabled()) event.preventDefault(); }, {signal: events.signal});
  return {release, close() { release(); events.abort(); }};
}
export function desktopCanvas(canvas, send, allowed) {
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('Canvas rendering is unavailable.');
  let ready = false, control = false;
  const input = canvasInput(canvas, send, () => ready && control && allowed());
  return {
    ready(width, height, mayControl) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 1280 || height < 1 || height > 800 || typeof mayControl !== 'boolean') throw new Error('Unsupported private desktop size.');
      canvas.width = width; canvas.height = height; ready = true; control = mayControl;
    },
    rectangle(data) {
      if (!ready || !allowed() || !(data instanceof ArrayBuffer) || data.byteLength < 8 || data.byteLength > 1280 * 800 * 4 + 8) throw new Error('Invalid private desktop frame.');
      const view = new DataView(data), x = view.getUint16(0), y = view.getUint16(2), w = view.getUint16(4), h = view.getUint16(6);
      if (!w || !h || x + w > canvas.width || y + h > canvas.height || data.byteLength !== 8 + w * h * 4) throw new Error('Invalid private desktop rectangle.');
      const raw = new Uint8Array(data, 8), image = context.createImageData(w, h);
      for (let i = 0; i < raw.length; i += 4) { image.data[i] = raw[i]; image.data[i + 1] = raw[i + 1]; image.data[i + 2] = raw[i + 2]; image.data[i + 3] = 255; }
      context.putImageData(image, x, y);
    },
    release: input.release,
    close() { input.close(); ready = false; control = false; context.clearRect(0, 0, canvas.width, canvas.height); canvas.width = canvas.height = 1; },
  };
}
