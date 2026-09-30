/* A loop held still for a long while (its window hidden, scrolled out of view, or in the long sleep, core/sleep.js)
   keeps a decoder and its frames while it is paused. hold17 gives them back: the frame it shows becomes its picture and
   its file is let go (data-held17 keeps which loop it is, data-at17 where it was). play17 loads it again at the same
   moment of the loop and plays it, so a loop that wakes carries on instead of starting over. A loop that is only waiting
   its turn to play (core/figures.js PLAY_MAX) is paused, not held: it plays again soon. */

export function hold17(v) {
  if (!v.paused) v.pause();
  const src = v.getAttribute("src");
  if (!src) return; // held already
  // A loop with no frame yet lets its file go as well: one told to play and held before its first frame arrived went
  // on loading it after the pause, and kept a decoder while held (tests/window-sleep.test.mjs, on a slow machine).
  if (v.readyState >= 2) {
    try {
      const frame = Object.assign(document.createElement("canvas"), { width: v.videoWidth, height: v.videoHeight });
      frame.getContext("2d").drawImage(v, 0, 0);
      v.poster = frame.toDataURL();
    } catch { /* its own still stays its picture */ }
  }
  v.dataset.held17 = src;
  v.dataset.at17 = String(v.currentTime);
  v.removeAttribute("src");
  v.load();
}

/* The loop a video shows, held or not. */
export const loopOf17 = (v) => v.getAttribute("src") ?? v.dataset.held17 ?? "";

export function play17(v) {
  const src = v.dataset.held17;
  if (src) {
    const at = Number(v.dataset.at17) || 0;
    delete v.dataset.held17;
    delete v.dataset.at17;
    if (at) v.addEventListener("loadedmetadata", () => { v.currentTime = at; }, { once: true });
    v.src = src;
  }
  return v.play();
}

/* A node that leaves the window for good lets its file go and forgets which loop it was. */
export function drop17(v) {
  v.pause();
  delete v.dataset.held17;
  delete v.dataset.at17;
  v.removeAttribute("src");
  v.load();
}
