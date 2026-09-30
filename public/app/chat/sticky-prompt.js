/* Adapted from NousResearch/hermes-agent a9a54245b2311c705d29050b7f9868c015917aec
 * apps/desktop/src/components/assistant-ui/thread/use-sticky-prompt-clip.ts.
 * MIT License
 * Copyright (c) 2025 Nous Research
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const TURN = "[data-chat-turn]", QUESTION = "[data-sticky-question]", CLIP = "--sticky-prompt-clip";
let controller = null;

/** Rebind only when the actual transcript/scroll nodes change; surviving clips stay through streaming. */
export function afterStickyPrompt(enabled = true) {
  const viewport = document.getElementById("scroll"), content = document.getElementById("conversation");
  if (!enabled || controller?.viewport !== viewport || controller?.content !== content) {
    controller?.dispose(); controller = null;
  }
  if (enabled && viewport && content && typeof IntersectionObserver === "function" && typeof ResizeObserver === "function") {
    controller ??= new StickyPrompt(viewport, content);
    controller.reconcile();
  }
}

class StickyPrompt {
  observed = new Set(); visible = new Set(); clipped = new Set(); frame = 0;
  constructor(viewport, content) {
    this.viewport = viewport; this.content = content;
    this.schedule = () => { if (!this.frame) this.frame = requestAnimationFrame(() => this.measure()); };
    this.sizes = new ResizeObserver(this.schedule);
    this.intersections = new IntersectionObserver(entries => {
      for (const entry of entries) this.watchVisible(entry.target, entry.isIntersecting);
      this.schedule();
    }, { root: viewport });
    this.mutations = new MutationObserver(() => this.reconcile());
    this.mutations.observe(content, { childList: true, subtree: true });
    this.sizes.observe(viewport); this.sizes.observe(content);
    viewport.addEventListener("scroll", this.schedule, { passive: true });
    document.addEventListener("selectionchange", this.schedule);
    content.addEventListener("focusin", this.schedule); content.addEventListener("focusout", this.schedule);
    content.classList.add("sticky-prompts");
  }
  watchVisible(turn, shown) {
    if (shown) {
      this.visible.add(turn); this.sizes.observe(turn);
      const prompt = turn.querySelector(QUESTION); if (prompt) this.sizes.observe(prompt);
    } else {
      this.visible.delete(turn); this.sizes.unobserve(turn);
      const prompt = turn.querySelector(QUESTION); if (prompt) this.sizes.unobserve(prompt);
    }
  }
  paused() {
    const selection = document.getSelection();
    return !!document.getElementById("find9-q") || !!selection && !selection.isCollapsed
      && (this.content.contains(selection.anchorNode) || this.content.contains(selection.focusNode))
      || this.content.contains(document.activeElement) && document.activeElement?.matches("button,input,textarea,a,[contenteditable]");
  }
  activePrompt(top, height) {
    let active = null, bottom = top;
    const tall = [];
    for (const turn of this.visible) {
      const prompt = turn.querySelector(QUESTION); if (!prompt) continue;
      const rect = prompt.getBoundingClientRect(), tooTall = rect.height > height * 0.35;
      tall.push([prompt, tooTall]);
      const stickyTop = Number.parseFloat(getComputedStyle(prompt).top) || 0;
      if (tooTall || rect.top > top + stickyTop + 1 || rect.bottom <= top) continue;
      if (!active || active.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING) { active = prompt; bottom = rect.bottom; }
    }
    return { active, bottom, tall };
  }
  covered(active, bottom) {
    const next = new Map();
    const collect = element => {
      if (element === active) return;
      if (element.contains(active)) { for (const child of element.children) collect(child); return; }
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.top < bottom) next.set(element, Math.min(rect.height, bottom - rect.top));
    };
    if (active) for (const turn of this.visible) for (const child of turn.children) collect(child);
    return next;
  }
  apply(next) {
    for (const element of this.clipped) if (!next.has(element)) {
      element.style.removeProperty(CLIP); element.removeAttribute("data-sticky-prompt-clip");
    }
    this.clipped.clear();
    for (const [element, inset] of next) {
      const value = `${inset}px`;
      if (element.style.getPropertyValue(CLIP) !== value) element.style.setProperty(CLIP, value);
      element.setAttribute("data-sticky-prompt-clip", ""); this.clipped.add(element);
    }
  }
  measure() {
    this.frame = 0;
    if (!this.viewport.isConnected || !this.content.isConnected) return this.dispose();
    const paused = this.paused();
    if (paused) { this.content.classList.add("sticky-paused"); this.apply(new Map()); return; }
    if (this.content.classList.contains("sticky-paused")) { this.content.classList.remove("sticky-paused"); this.schedule(); return; }
    const bounds = this.viewport.getBoundingClientRect();
    const { active, bottom, tall } = this.activePrompt(bounds.top, bounds.height);
    const next = this.covered(active, bottom);
    // Geometry reads precede clipping writes. Never mask the IntersectionObserver target itself.
    this.apply(next);
    for (const [prompt, tooTall] of tall) {
      if (prompt.hasAttribute("data-sticky-tall") !== tooTall) { prompt.toggleAttribute("data-sticky-tall", tooTall); this.schedule(); }
    }
  }
  reconcile() {
    const turns = new Set(this.content.querySelectorAll(TURN)), bounds = this.viewport.getBoundingClientRect();
    for (const turn of this.observed) if (!turns.has(turn)) {
      this.intersections.unobserve(turn); this.watchVisible(turn, false); this.observed.delete(turn);
    }
    for (const turn of turns) {
      if (!this.observed.has(turn)) { this.intersections.observe(turn); this.observed.add(turn); }
      // Outer boxes only: skipped content-visibility descendants remain asleep.
      const rect = turn.getBoundingClientRect(); this.watchVisible(turn, rect.bottom > bounds.top && rect.top < bounds.bottom);
    }
    cancelAnimationFrame(this.frame); this.measure();
  }
  dispose() {
    this.intersections.disconnect(); this.sizes.disconnect(); this.mutations.disconnect();
    this.viewport.removeEventListener("scroll", this.schedule); document.removeEventListener("selectionchange", this.schedule);
    this.content.removeEventListener("focusin", this.schedule); this.content.removeEventListener("focusout", this.schedule);
    cancelAnimationFrame(this.frame); this.apply(new Map());
    this.content.classList.remove("sticky-prompts", "sticky-paused");
    for (const prompt of this.content.querySelectorAll("[data-sticky-tall]")) prompt.removeAttribute("data-sticky-tall");
  }
}
