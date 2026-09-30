/** Optional arrows on ordinary action lists; Tab/Enter/Space retain native button behavior. */
export function initHomeListKeys() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = { ArrowUp: -1, ArrowDown: 1, Home: "first", End: "last" }[event.key];
    if (!step) return;
    const button = event.target.closest?.("button"), list = button?.closest("[data-home-list]");
    if (!list) return;
    const buttons = [...list.querySelectorAll("button:not(:disabled)")].filter((item) => item.getClientRects().length && item.getAttribute("aria-disabled") !== "true");
    const index = buttons.indexOf(button);
    if (index < 0) return;
    const next = step === "first" ? 0 : step === "last" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + step));
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: "nearest" });
  });
}
