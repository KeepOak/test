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
    const box = document.body.firstElementChild.getBoundingClientRect();
    say({ kind: "drawn", height: Math.ceil(box.height), width: Math.ceil(box.width) });
  }
  // Nothing in the frame goes anywhere when pressed.
  addEventListener("click", (event) => event.preventDefault(), true);
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const { source, dark } = event.data ?? {};
    if (typeof source !== "string" || !source.trim() || source.length > 50000) return;
    draw(source, dark === true).catch((error) => say({ kind: "failed", error: String(error?.message ?? error).slice(0, 300) }));
  });
  say({ kind: "ready" });
})();
