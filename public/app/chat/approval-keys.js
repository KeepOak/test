/* One guarded dispatcher approach reviewed in Hermes approval-keys.ts
   (Nous Research, MIT, a9a54245b2311c705d29050b7f9868c015917aec). Original Branch implementation. */
const ACTIONS = "button[data-act='ask'], button[data-act='room-ask'], button[data-act='g-ans']";
function approvalKey(e) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== "Enter" && e.key !== "Escape") return;
  const card = e.target;
  if (!(card instanceof HTMLElement) || !card.matches("[data-approval-card]") || document.activeElement !== card) return;
  if (card.closest("[inert], [aria-hidden='true']") || !card.getClientRects().length || document.querySelector("[role='dialog'][aria-modal='true']")) return;
  const wanted = e.key === "Enter" ? "allow" : "deny";
  const button = [...card.querySelectorAll(ACTIONS)].find((b) => b.dataset.v === wanted);
  if (!button || !/^[a-f0-9]{32}$/.test(button.dataset.fp ?? "")) return;
  e.preventDefault();
  e.stopPropagation();
  if (!button.disabled && !button.closest("[inert], [aria-disabled='true']")) button.click();
}
export function initApprovalKeys() { document.addEventListener("keydown", approvalKey); }
