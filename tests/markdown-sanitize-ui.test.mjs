/* UP-UI-003: rendered Markdown passes through the vendored DOMPurify with a small allow-list: no script links, no images
   or event handlers, no forged card markers, while Branch's own chart cards and links still come through. The window's
   own modules, run in a headless window. Mutation: return the parser's output unsanitized from chat/markdown.js: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("UP-UI-003: dangerous markup is removed and Branch's own cards survive", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  const out = await page.evaluate(async () => {
    const { sanitizeMarkdown } = await import("/app/chat/markdown-sanitize.js");
    const { text } = await import("/app/chat/markdown.js");
    const probe = (html) => { const box = document.createElement("div"); box.innerHTML = html; return box; };
    const dirty = probe(sanitizeMarkdown('<a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)"><svg><script>alert(1)</script></svg><p onclick="alert(1)" data-act="chat">p</p><a href="https://example.com/a">ok</a>'));
    const reply = probe(text('[site](https://example.com/b) and [bad](javascript:alert(1))\n\n<div data-branch-card="0-0"></div>\n\n```chart\n{"type":"bar","title":"T","data":[{"label":"a","value":1},{"label":"b","value":2}]}\n```'));
    return {
      scriptLink: [...dirty.querySelectorAll("a")].filter((a) => /^javascript:/i.test(a.getAttribute("href") ?? "")).length,
      images: dirty.querySelectorAll("img, svg, script").length,
      handlers: dirty.querySelectorAll("[onclick], [onerror], [data-act]").length,
      safeLink: dirty.querySelector('a[href="https://example.com/a"]')?.getAttribute("rel"),
      replyLinks: [...reply.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
      forged: reply.querySelectorAll("[data-branch-card]").length,
      chart: reply.querySelectorAll("svg").length,
    };
  });
  assert.equal(out.scriptLink, 0);
  assert.equal(out.images, 0);
  assert.equal(out.handlers, 0);
  assert.equal(out.safeLink, "noopener noreferrer");
  assert.deepEqual(out.replyLinks, ["https://example.com/b"]);
  assert.equal(out.forged, 0, "a reply cannot plant a card marker");
  assert.ok(out.chart >= 1, "Branch's own chart card still draws");
  assert.deepEqual(errors, []);
});
