/* UP-UI-002: replies are parsed as whole Markdown (markdown-it, vendored in public/app/vendor): a list after an opening
   line stays a list, inline code is not parsed inside, a link keeps its balanced parentheses, and nothing in a reply
   becomes markup or a script link (raw HTML off, images off, http/https/mailto only). Rendered in the real window. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("a reply's lists, code and links render whole, and nothing in it becomes markup", async (t) => {
  const { page } = await newWindow(t);
  const html = await page.evaluate(async () => (await import("/app/chat/markdown.js")).text([
    "Here is the plan:", "- one", "  - nested", "- two", "",
    "Use `**not bold**` and [docs](https://example.com/a_(b)).", "",
    "<script>alert(1)</script> [bad](javascript:alert(1)) ![pic](https://example.com/p.png) [mail](mailto:a@example.com)",
  ].join("\n")));
  assert.match(html, /<p>Here is the plan:<\/p>\s*<ul>\s*<li>one\s*<ul>\s*<li>nested<\/li>/, "the list after an opening line is a list, nested kept");
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/, "inline code is not parsed inside");
  assert.match(html, /href="https:\/\/example\.com\/a_\(b\)" target="_blank" rel="noopener noreferrer"/, "balanced parentheses stay in the link");
  assert.doesNotMatch(html, /<script|href="javascript:|<img/i, "no raw HTML, script link or image");
  assert.match(html, /&lt;script&gt;/, "raw HTML is shown as words");
  assert.match(html, /href="mailto:a@example\.com"/);
});
