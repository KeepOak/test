/* Approval-aware jump and held-selection approach reviewed in Hermes scroll-to-bottom-button.tsx/thread/list.tsx
   (Nous Research, MIT, a9a54245b2311c705d29050b7f9868c015917aec). Original Branch implementation. */
import { $, afterDraw, render, renderNow } from "../core/dom.js";
import { S, E, activeId } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t, plural } from "../../i18n.js";

let read = () => ({ sessionId: null }), held = false, selectedScope = null, frame = 0;
export const privateContext = () => JSON.stringify([activeId(), E.profiles?.isOwner ?? null, S.signedIn,
  document.getElementById("app")?.classList.contains("locked-b17") ?? false, !!$(".lockscreen")]);
/* The App lock's own state, without its activity clock (lastActiveAt moves on every request, which is no reason to redraw). */
const lockOf = (lock) => (lock ? [lock.locked, lock.lockedSince, lock.pinSet, lock.lockOnOpen, lock.secretsWhileLocked] : null);
export function scrollSecurity() {
  const state = E.state ?? {};
  return JSON.stringify([privateContext(), S.chat, read().sessionId, E.profiles?.active ?? null, E.trunkModes,
    lockOf(state.lock), state.approvalCategories, state.askFirst, state.practice, state.network, state.privacy,
    state.skillPolicy, state.setAside, state.preferences, document.getElementById("app")?.classList.contains("locked") ?? false]);
}
export function selectionHeld(root) {
  const selection = document.getSelection();
  return !!root && !selection?.isCollapsed && !!selection?.rangeCount &&
    (!selectedScope || selectedScope === scrollSecurity()) &&
    (root.contains(selection.anchorNode) || root.contains(selection.focusNode));
}
export const jumpRow = () => `<div class="jump-follow" id="jump-follow" hidden><button class="btn sm" type="button" data-act="jump-follow" aria-controls="scroll">${t("window.chat.follow.latest")}</button></div>`;
function approval(box) {
  return [...box.querySelectorAll(".ask, .g-row")].find((card) => [...card.querySelectorAll("button[data-fp]")].some((button) =>
    ["ask", "room-ask", "g-ans"].includes(button.dataset.act) && /^[a-f0-9]{32}$/.test(button.dataset.fp ?? "") && !button.disabled));
}
function update() {
  frame = 0;
  const box = $("#scroll"), row = $("#jump-follow"), button = row?.querySelector("button");
  if (!box || !row || !button) return;
  const below = box.scrollHeight - box.scrollTop - box.clientHeight;
  row.hidden = S.view !== "chat" || below < 40;
  if (row.hidden) return;
  const bottom = box.getBoundingClientRect().bottom;
  const messages = [...box.querySelectorAll("[data-i15]")].filter((node) => node.getBoundingClientRect().top >= bottom);
  const count = new Set(messages.map((node) => node.dataset.i15)).size;
  const words = approval(box) ? t("window.chat.follow.approval") : t("window.chat.follow.latest");
  button.textContent = words + (count ? " · " + plural(count, { one: "window.chat.follow.below-one", other: "window.chat.follow.below-many" }) : "");
}
export const refreshScrollFollow = () => { if (!frame) frame = requestAnimationFrame(update); };
function jump() {
  document.getSelection()?.removeAllRanges();
  renderNow();
  const box = $("#scroll");
  if (!box) return;
  const card = approval(box);
  if (card) box.scrollTop += card.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
  else box.scrollTop = box.scrollHeight;
  const state = read(); state.readTop = box.scrollTop; state.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  update();
}
export function initScrollFollow(state) {
  read = state; markLive(["jump-follow"]); on("jump-follow", jump); afterDraw(refreshScrollFollow);
  document.addEventListener("scroll", (e) => { if (e.target.id === "scroll") refreshScrollFollow(); }, { capture: true, passive: true });
  document.addEventListener("load", (e) => { if (e.target.closest?.("#scroll")) refreshScrollFollow(); }, true);
  document.addEventListener("selectionchange", () => {
    const selected = selectionHeld($("#scroll")) || selectionHeld($(".beside15 .thread"));
    if (selected && !held) selectedScope = scrollSecurity();
    if (!selected && held) { selectedScope = null; render(); }
    held = selected;
  });
  addEventListener("resize", refreshScrollFollow);
}
