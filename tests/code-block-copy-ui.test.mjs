/* UP-UI-005: a code block in a reply carries its language label and a Copy button that copies exactly the code, with
   its spacing and line ends. A headless window on a temporary Branch renders one reply's Markdown.
   Mutation: in chat/markdown.js send fences back to markdown-it's own renderer: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { waitInPage } from "./wait-in-page.mjs";

const code = "def hi():\n    return '<b>&amp;</b>'\n";

test("UP-UI-005: a fenced block is labelled with its language and Copy copies the code exactly", { timeout: 180000 }, async (t) => {
  const { page, errors } = await newWindow(t);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async (source) => {
    const { text } = await import("/app/chat/markdown.js");
    const holder = document.createElement("div");
    holder.id = "code-test";
    holder.innerHTML = text("Here it is:\n\n```python\n" + source + "```\n\n    indented block\n");
    document.body.append(holder);
  }, code);
  const blocks = page.locator("#code-test .code-window14");
  assert.equal(await blocks.count(), 2, "fenced and indented blocks both get the window");
  assert.equal(await blocks.first().locator(".code-window14-head span").innerText(), "python");
  assert.equal(await blocks.nth(1).locator(".code-window14-head span").innerText(), "text", "no language says text");
  assert.equal(await blocks.first().locator("pre code").innerText(), code, "the code is shown as words, not markup");
  assert.equal(await page.locator("#code-test b").count(), 0);
  await blocks.first().locator('[data-act="code-copy14"]').click();
  await waitInPage(page, async (want) => (await navigator.clipboard.readText()) === want, code, { timeout: 10000 });
  assert.deepEqual(errors, []);
});
