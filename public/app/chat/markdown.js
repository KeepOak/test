/* Answers arrive as Markdown. This draws the safe subset the conversation needs — paragraphs, line breaks, bold,
   italic, inline code, code blocks, headings, lists, tables, links and quotes — from escaped text, so nothing in an
   answer can become markup. No images, no javascript: links, all hrefs http(s) only opening in a new tab with rel="noopener noreferrer", so the window itself is never led away. A ```chart
   block is drawn as the design's chart card (chart.js), a ```mermaid block as the diagram card (diagram.js). */

import { esc } from "../core/dom.js";
import { chartCard } from "./chart.js";
import { diagramCard } from "./diagram.js";

const inline = (s) => {
  if (!s) return "";
  // Links: [text](url) but only http(s) urls; input is already escaped, so don't double-escape
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (!/^https?:\/\//.test(url)) return match; // not http(s), return literal
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Code: backticks; content is already escaped
  s = s.replace(/`([^`]+)`/g, (match, code) => `<code>${code}</code>`);
  // Bold and italic; content is already escaped
  s = s.replace(/\*\*([^*]+)\*\*/g, (match, bold) => `<strong>${bold}</strong>`);
  s = s.replace(/\*([^*]+)\*/g, (match, italic) => `<em>${italic}</em>`);
  return s;
};

function block(chunk) {
  const lines = chunk.split("\n");

  // Empty
  if (!chunk.trim()) return "";

  // Heading: a first line of # to ######; whatever follows it in the chunk is drawn as its own block.
  const heading = lines[0].match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const rest = lines.slice(1).join("\n");
    return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>${rest.trim() ? block(rest) : ""}`;
  }

  // Quote: the text is already escaped, so ">" arrives as "&gt;".
  if (/^&gt;\s?/.test(chunk)) {
    const quoted = lines.map((l) => l.replace(/^\s*&gt;\s?/, "")).join("\n");
    return `<blockquote>${block(quoted)}</blockquote>`;
  }

  // Table: a header row, a |---| separator row (not drawn), then the rows.
  if (lines.length >= 3 && /^\s*\|.*\|/.test(lines[0]) && /^\s*\|[\s\-|:]+\|/.test(lines[1])) {
    const rows = [lines[0], ...lines.slice(2)].filter((l) => /^\s*\|/.test(l)).map((l) =>
      l.split("|").slice(1, -1).map((cell) => inline(cell.trim()))
    );
    if (rows.length > 1) {
      const [header, ...body] = rows;
      return `<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
  }

  // Unordered list
  if (lines.every((l) => !l.trim() || /^\s*[-*] /.test(l))) {
    const items = lines.filter((l) => /^\s*[-*] /.test(l));
    if (items.length) return `<ul>${items.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
  }

  // Ordered list
  if (lines.every((l) => !l.trim() || /^\s*\d+[.)] /.test(l))) {
    const items = lines.filter((l) => /^\s*\d+[.)] /.test(l));
    if (items.length) return `<ol>${items.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`;
  }

  // Paragraph with line breaks
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

/* A fenced block: a ```chart block that has something to draw becomes the chart card (chart.js); any other is code. */
function fenced(part) {
  const lang = /^([a-z0-9-]*)\n/i.exec(part);
  const body = lang ? part.slice(lang[0].length) : part;
  if (lang?.[1].toLowerCase() === "mermaid" && body.trim()) return diagramCard(body.trimEnd()); // pass 17: chat/diagram.js
  return (lang?.[1].toLowerCase() === "chart" && chartCard(body)) || `<pre><code>${esc(body)}</code></pre>`;
}

/* One line of words with only the inline part (bold, italic, code, links), for a line that is not a whole answer. */
export const inlineText = (words) => inline(esc(words));

export function text(markdown) {
  return String(markdown ?? "").split(/```/).map((part, i) => (i % 2
    ? fenced(part)
    : esc(part).split(/\n{2,}/).map((c) => c.trim()).filter(Boolean).map(block).join(""))).join("");
}
