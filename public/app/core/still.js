/* Faces breathe and blink (app.css breathe11, blink11). The browser animates a face that is scrolled out of sight on
   every frame all the same, and a long conversation has one face per reply: with 300 messages open that was about
   3.5 s of work a minute while nothing happened. A face out of its list's view is held still (.still-perf) and moves
   again as it scrolls back into view, so nothing on screen looks different. */
const watchers = new WeakMap();

/* Watches the faces now drawn inside a scrolling box (the thread's #scroll, the sidebar's list). Run after each draw. */
export function stillOutOfSight(box) {
  if (!box) return;
  let seen = watchers.get(box);
  if (!seen) {
    seen = new IntersectionObserver((entries) => {
      for (const entry of entries) entry.target.classList.toggle("still-perf", !entry.isIntersecting);
    }, { root: box, rootMargin: "120px 0px" });
    watchers.set(box, seen);
  }
  seen.disconnect();
  for (const face of box.querySelectorAll(".av")) seen.observe(face);
}
