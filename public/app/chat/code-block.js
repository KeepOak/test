import { esc } from "../core/dom.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

/* OpenClaw markdown-code-blocks.ts (OpenClaw Foundation, MIT) informed the
   header and JSON clipboard payload approach; original Branch implementation. */
export function codeBlock(content, language = "") {
  const body = String(content ?? ""), label = String(language || "text").slice(0, 64);
  // JSON preserves whitespace and line endings through HTML attribute parsing.
  const payload = JSON.stringify(body).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<div class="code-window14"><div class="code-window14-head"><span>${esc(label)}</span><button class="btn ghost sm" type="button" data-act="code-copy14" data-code-json="${esc(payload)}" aria-label="${esc(t("action.copy-code"))}">${esc(t("action.copy-code"))}</button></div><pre><code>${esc(body)}</code></pre></div>`;
}

async function copyCode(button) {
  try {
    const code = JSON.parse(button.dataset.codeJson ?? "null");
    if (typeof code !== "string") throw new Error("Invalid code payload");
    await navigator.clipboard.writeText(code);
    toast(t("markdown.copied"));
  } catch { toast(t("markdown.status.copyFailed")); }
}

if (!has("code-copy14")) {
  on("code-copy14", (button) => copyCode(button));
  markLive(["code-copy14"]);
}
