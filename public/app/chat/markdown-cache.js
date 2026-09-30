/* Exact-text LRU approach adapted from OpenClaw's Markdown cache (OpenClaw Foundation, MIT).
   Entry and combined text/output budgets avoid retaining large conversation histories. */
const cache = new Map();
const MAX_ENTRIES = 100, MAX_TEXT = 25000, MAX_CHARS = 300000;
let chars = 0;

export function cachedMarkdown(value, render) {
  const source = String(value ?? "");
  /* Cards include current run/library state and translated controls, so always rebuild them. */
  if (source.length > MAX_TEXT || /(?:`{3,}|~{3,})\s*(?:chart|mermaid)\b/i.test(source)) return render(source);
  const hit = cache.get(source);
  if (hit !== undefined) {
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const html = render(source), cost = source.length + html.length;
  if (cost > MAX_CHARS) return html;
  cache.set(source, html);
  chars += cost;
  while (cache.size > MAX_ENTRIES || chars > MAX_CHARS) {
    const oldest = cache.keys().next().value;
    chars -= oldest.length + cache.get(oldest).length;
    cache.delete(oldest);
  }
  return html;
}

/* Rendered messages from a previous person/window are not kept after the session changes. */
export function clearMarkdownCache() { cache.clear(); chars = 0; }
globalThis.document?.addEventListener("branch-language", clearMarkdownCache);
globalThis.addEventListener?.("pagehide", clearMarkdownCache);
