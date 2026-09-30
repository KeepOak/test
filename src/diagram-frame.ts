import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The sealed frame a ```mermaid block in a reply is drawn in (chat/diagram.js).
 *
 * Mermaid (MIT, vendored at exactly 11.17.2 in public/vendor/, no CDN) needs to run a script and to write inline styles,
 * and the window's own policy allows neither, on purpose. So it never runs in the window: the window shows this page in an
 * iframe sandboxed with "allow-scripts" only (no same origin: the frame's origin is opaque, so it cannot read the window,
 * its storage or the session key), and this page carries its own policy, stricter than the window's everywhere except
 * that it lets the drawing's own <style> in:
 *
 *   - scripts: only the two files this response names, by a nonce made for this response; nothing inline, no eval;
 *   - styles: inline allowed, here only (Mermaid writes its colours into the drawing);
 *   - nothing is fetched or sent (connect, images other than data:, fonts, media, frames, forms, workers: none);
 *   - only the window itself may frame it, and the policy sandboxes it again whoever frames it.
 *
 * Mermaid runs with securityLevel "strict" (its own sanitiser, no click handlers, no HTML labels), which a diagram's
 * %%{init}%% directive cannot lower. The diagram's text arrives by postMessage from the window and the drawing never
 * leaves the frame; only its height goes back. The window's policy is unchanged.
 */
export const mermaidVersion = "11.17.2";
const vendor = `vendor/mermaid-${mermaidVersion}/mermaid.min.js`;
/** The drawer's address names its version, so the browser may keep it: 3.5 MB is not fetched again for every diagram. */
const drawer = `/diagram-frame/mermaid-${mermaidVersion}.min.js`;
const files: Record<string, [string, string, string]> = {
  [drawer]: [vendor, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"],
  "/diagram-frame/frame.js": ["diagram-frame.js", "text/javascript; charset=utf-8", "no-store"],
};

/** The frame's policy, for one nonce. Exported so a test can hold it to exactly this. */
export function diagramFramePolicy(nonce: string): string {
  return [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'", "img-src data:", "font-src 'none'",
    "connect-src 'none'", "media-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'",
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", "sandbox allow-scripts",
  ].join("; ");
}

function page(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Diagram</title>`
    + "<style>html,body{margin:0;background:transparent}html{overflow:auto}svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>"
    + `<script nonce="${nonce}" src="${drawer}"></script>`
    + `<script nonce="${nonce}" src="/diagram-frame/frame.js"></script></head><body></body></html>`;
}

/** `GET /diagram-frame` and its two scripts. Returns false for any other request. No key is needed: nothing here is private. */
export async function diagramFrameRoute(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  if (request.method !== "GET") return false;
  const common = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (path === "/diagram-frame") {
    const nonce = randomBytes(18).toString("base64url");
    response.writeHead(200, { ...common, "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "content-security-policy": diagramFramePolicy(nonce) });
    response.end(page(nonce));
    return true;
  }
  const file = Object.hasOwn(files, path) ? files[path] : undefined;
  if (!file) return false;
  // Asked for by a frame whose origin is opaque, so the script is fetched with no credentials and needs no key.
  const body = await readFile(new URL(`../public/${file[0]}`, import.meta.url));
  response.writeHead(200, { ...common, "content-type": file[1], "cache-control": file[2] });
  response.end(body);
  return true;
}
