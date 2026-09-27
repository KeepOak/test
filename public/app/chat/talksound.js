/* Talk live's sound arithmetic, kept apart from the window so a test can check it in node against the engine's own code
   (src/realtime-socket.ts audioFrame/readAudioFrame): the microphone's sound turned into the 16-bit whole numbers both
   live services want, and one numbered block of the answer's sound read off the socket. */

/** The browser's floating-point sound as PCM16; anything too loud is clipped, not wrapped. */
export function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** One block of sound from the socket: its place in the order (4 bytes), then the sound itself. */
export function readAudioFrame(bytes) {
  const view = new DataView(bytes);
  return { sequence: view.getUint32(0), pcm16: new Int16Array(bytes.slice(4)) };
}
