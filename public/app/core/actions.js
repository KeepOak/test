/* Every control carries data-act="<name>"; this is the one place clicks are routed. Areas register with on(). */

const ACTS = new Map();

/* on('send', (el, event) => …) — one handler per name; registering a name twice is a bug and throws. */
export function on(name, handler) {
  if (ACTS.has(name)) throw new Error(`Action "${name}" is registered twice`);
  ACTS.set(name, handler);
}
export const has = (name) => ACTS.has(name);
export function run(name, el = document.createElement("button"), event = null) {
  const handler = ACTS.get(name);
  if (handler) return handler(el, event);
}

export function listen(root = document) {
  root.addEventListener("click", (event) => {
    const el = event.target.closest?.("[data-act]");
    if (!el || el.closest("[aria-disabled='true']") || el.disabled) return;
    const handler = ACTS.get(el.dataset.act);
    if (!handler) return;
    event.preventDefault();
    handler(el, event);
  });
}
