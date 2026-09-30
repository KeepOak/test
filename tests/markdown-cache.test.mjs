/* UP-UI-004: a reply whose text has not changed is not parsed again on every redraw. The cache is bounded by entries
   and by characters, skips very long replies and live cards (charts, diagrams), and is emptied on a language change.
   The window's own module, loaded in Node; nothing is drawn. */
import test from "node:test";
import assert from "node:assert/strict";
import { cachedMarkdown, clearMarkdownCache } from "../public/app/chat/markdown-cache.js";

function counting() {
  const seen = [];
  return { seen, render: (source) => { seen.push(source); return `<p>${source}</p>`; } };
}

test("UP-UI-004: the same reply is parsed once and then served from the cache", () => {
  clearMarkdownCache();
  const { seen, render } = counting();
  assert.equal(cachedMarkdown("Hello **there**", render), "<p>Hello **there**</p>");
  assert.equal(cachedMarkdown("Hello **there**", render), "<p>Hello **there**</p>");
  assert.equal(cachedMarkdown("Something else", render), "<p>Something else</p>");
  assert.deepEqual(seen, ["Hello **there**", "Something else"]);
  clearMarkdownCache();
  cachedMarkdown("Hello **there**", render);
  assert.equal(seen.length, 3, "a cleared cache parses again");
});

test("UP-UI-004: charts, diagrams and very long replies are always rebuilt", () => {
  clearMarkdownCache();
  const { seen, render } = counting();
  const chart = "```chart\n{\"type\":\"bar\"}\n```", long = "x".repeat(25001);
  for (let i = 0; i < 2; i++) { cachedMarkdown(chart, render); cachedMarkdown("~~~mermaid\ngraph TD\n~~~", render); cachedMarkdown(long, render); }
  assert.equal(seen.length, 6);
});

test("UP-UI-004: the cache keeps at most 100 replies, dropping the least recently shown", () => {
  clearMarkdownCache();
  const { seen, render } = counting();
  for (let i = 0; i < 100; i++) cachedMarkdown(`reply ${i}`, render);
  cachedMarkdown("reply 0", render); // shown again, so it is now the newest
  cachedMarkdown("reply 100", render); // pushes out the oldest, "reply 1"
  const before = seen.length;
  cachedMarkdown("reply 0", render);
  assert.equal(seen.length, before, "reply 0 was kept");
  cachedMarkdown("reply 1", render);
  assert.equal(seen.length, before + 1, "reply 1 was dropped");
});
