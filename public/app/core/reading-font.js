/* Font suggestions and the preferred-face-before-theme-stack approach follow Hermes Desktop
   (Nous Research, MIT); adapted to Branch's bounded preference and existing --sans token. */
export const READING_FONTS = ["Atkinson Hyperlegible", "OpenDyslexic", "Lexend", "Arial", "Georgia", "Verdana", "Segoe UI"];
let applied = null;

export function applyReadingFont(preferences = {}, force = false) {
  const key = JSON.stringify([preferences.font, preferences.readingFont]);
  if (!force && key === applied) return;
  applied = key;
  const root = document.documentElement;
  root.style.removeProperty("--sans");
  const fallback = preferences.font === "system"
    ? 'system-ui, "Segoe UI", sans-serif'
    : getComputedStyle(root).getPropertyValue("--sans").trim();
  if (READING_FONTS.includes(preferences.readingFont)) {
    root.style.setProperty("--sans", `${JSON.stringify(preferences.readingFont)}, ${fallback || "sans-serif"}`);
  } else if (preferences.font === "system") root.style.setProperty("--sans", fallback);
}
