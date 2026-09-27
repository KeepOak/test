/** What every phone screen shares: the native plugin, the words, escaping, and which platform draws the screens. */
import { t } from "/i18n.js";

export const $ = (id) => document.getElementById(id);
/**
 * The native side (BranchPhone), reached through the bridge Capacitor puts on every app page
 * (`nativePromise`), so the page needs no bundled copy of @capacitor/core. In the screen tests and the
 * verify script a stand-in takes its place.
 */
function nativePlugin(cap = globalThis.Capacitor) {
  if (!cap?.nativePromise || !cap.PluginHeaders?.some((header) => header.name === "BranchPhone")) return null;
  const call = (method) => (options) => cap.nativePromise("BranchPhone", method, options ?? {});
  return new Proxy({}, { get: (_, method) => (typeof method === "string" && method !== "then" ? call(method) : undefined) });
}
export const plugin = nativePlugin() ?? globalThis.branchPhoneFake ?? null;
/** "ios" or "and": the prototype draws the iPhone and the Android app apart (large titles or an app bar, and so on). */
export const platform = () => {
  const said = globalThis.Capacitor?.getPlatform?.() ?? globalThis.branchPhoneFake?.platform;
  if (said === "ios" || said === "android") return said === "ios" ? "ios" : "and";
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ? "ios" : "and";
};
const fill = (text, values) => (values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text);
/** A word from the language file, or the English given here when that file has no such key. */
export const say = (key, english, values) => { const word = t(key, values); return word === key ? fill(english ?? key, values) : word; };
/** Everything that came from the engine goes through this before it is put into a screen. */
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A word, escaped, ready for a screen's markup. */
export const w = (key, english, values) => esc(say(key, english, values));
export function status(id, text, bad = false) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("bad", bad);
}
/** The page's one piece of shared state: the vault once the plugin is known, and what was shared in. */
export const phone = { vault: null, shared: [] };
/** An error in the chosen language when it carries a key, otherwise the words it came with. */
export const describe = (error) => (error?.key ? say(error.key, error.message) : String(error?.message ?? error));
