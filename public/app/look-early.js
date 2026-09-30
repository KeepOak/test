/* UP-UI-051: the look worn last, put on before the first paint, so the window never shows Branch Slate in the other light
   while it signs in, asks the engine for the look and reads the theme catalogue. shell/look.js applyLook() keeps what it
   wore (light or dark, or following this computer; the look's id; More contrast; its colours in both lights), and this
   puts it on the page. Slate is kept too, so going back to it never paints the old look first. A classic script in the
   page's head, its own file because the window's rules refuse inline script; what it reads is checked before use.
   Adapted from OpenCode's oc-theme-preload.js (packages/app/public, MIT); see THIRD_PARTY_NOTICES.md. */
(function () {
  "use strict";
  var early = null;
  try { early = JSON.parse(localStorage.getItem("branch-look-early") || "null"); } catch (error) { early = null; }
  if (!early || typeof early !== "object") return;
  var root = document.documentElement;
  if (early.theme === "light" || early.theme === "dark") root.setAttribute("data-theme", early.theme);
  if (typeof early.palette === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(early.palette)) root.setAttribute("data-palette", early.palette);
  if (early.contrast === true) root.classList.add("contrast17");
  var mode = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  var vars = early.vars && early.vars[mode];
  if (!vars || typeof vars !== "object") return;
  var colour = /^(#[0-9A-Fa-f]{3,8}|rgba?\([0-9.,%\s]+\))$/;
  for (var name in vars) {
    if (Object.prototype.hasOwnProperty.call(vars, name) && /^--[a-z0-9-]+$/.test(name) && colour.test(String(vars[name]))) root.style.setProperty(name, vars[name]);
  }
})();
