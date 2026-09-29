/* The sealed frame's own script (src/diagram-frame.ts): draws one Mermaid diagram from the text the window posts, inside
   this frame only, and tells the window how tall it came out. It takes words only from the window that framed it, draws
   with Mermaid's strict security level, and never sends the drawing anywhere. The frame's policy runs no other script. */
(() => {
  "use strict";
  const say = (message) => parent.postMessage(message, "*"); // the window's origin is not ours to know here (opaque)
  const settings = (dark) => ({
    startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "system-ui, sans-serif",
    flowchart: { htmlLabels: false }, maxTextSize: 50000,
    // Keys a diagram's own %%{init}%% line may never change.
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "flowchart"],
  });
  let drawn = 0;
  /* The text this frame was told, kept here: a change of colours sends no text again, only whether the window is dark. */
  let told = "";
  async function draw(source, dark) {
    const mermaid = globalThis.mermaid;
    if (!mermaid) throw new Error("The diagram drawer did not load.");
    mermaid.initialize(settings(dark));
    const { svg } = await mermaid.render(`diagram-${++drawn}`, source);
    const picture = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    if (picture.nodeName.toLowerCase() !== "svg") throw new Error("The diagram could not be drawn.");
    // A link in a drawing would take this frame to another page (and the diagram's words with it): links are unwrapped.
    for (const link of picture.querySelectorAll("a")) link.replaceWith(...link.childNodes);
    document.body.replaceChildren(document.importNode(picture, true));
    fit();
  }
  /* A drawing wider than the frame keeps its own size and the frame scrolls sideways, rather than shrinking past reading;
     the frame changing size (a narrower window) fits it again, and says its new height. */
  function fit() {
    const shown = document.body.firstElementChild;
    if (!shown) return;
    const natural = shown.viewBox?.baseVal?.width ?? 0, wide = natural > innerWidth;
    Object.assign(shown.style, { maxWidth: wide ? "none" : "", width: wide ? `${Math.ceil(natural)}px` : "" });
    const box = shown.getBoundingClientRect();
    say({ kind: "drawn", height: Math.ceil(box.height) + (wide ? 18 : 0), width: Math.ceil(box.width) }); // room for the sideways scrollbar
  }
  let lastWidth = innerWidth;
  addEventListener("resize", () => { if (innerWidth !== lastWidth) { lastWidth = innerWidth; fit(); } });
  // Nothing in the frame goes anywhere when pressed.
  addEventListener("click", (event) => event.preventDefault(), true);
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const { source, dark } = event.data ?? {};
    const text = typeof source === "string" && source.trim() ? source : told;
    if (!text) return;
    if (text.length > 50000) { say({ kind: "failed", error: "This diagram is too long to draw." }); return; }
    told = text;
    draw(text, dark === true).catch((error) => say({ kind: "failed", error: String(error?.message ?? error).slice(0, 300) }));
  });
  say({ kind: "ready" });
})();
