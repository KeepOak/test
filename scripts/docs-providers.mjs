// Writes the "Which model services work" table in docs/configuration.md straight from
// data/providers.json, so the documentation cannot drift away from what the program actually does.
// Run it with `npm run docs:providers`. It only ever rewrites the block between the two markers.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const start = "<!-- providers:start -->";
const end = "<!-- providers:end -->";

const plain = {
  chat: "conversation",
  vision: "pictures in",
  tools: "tools",
  "json-mode": "fixed format",
  streaming: "as it types",
  embeddings: "compare passages",
  audio: "speech",
  images: "pictures out",
  realtime: "live conversation",
};
const shapes = {
  "openai-chat": "OpenAI",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic",
  gemini: "Gemini",
  "azure-openai": "Azure",
  "bedrock-converse": "Bedrock",
  "cohere-chat-v2": "Cohere v2",
  ollama: "Ollama",
  "perplexity-agent": "Perplexity Agent",
  "anthropic-vertex": "Anthropic on Vertex",
};
const standing = {
  official: "",
  unofficial: " (unofficial)",
  retired: " (retired)",
  "not-offered": " (not offered)",
};
const termsCell = (terms) => `[${escape(terms.route)}](${terms.url})${standing[terms.standing]}`;

const escape = (text) => String(text).replace(/\|/g, "\\|");

function table(catalog) {
  const rows = [...catalog.services].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = [
    "| Service | Where it runs | Speaks | What it can do | What you have to fill in | Route and terms |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of rows) {
    const needs = (entry.extras ?? []).filter((extra) => extra.required).map((extra) => extra.label);
    lines.push([
      "",
      escape(entry.name),
      entry.kind === "local" ? "on this computer" : "in the cloud",
      escape(shapes[entry.shape] ?? entry.shape),
      escape(entry.capabilities.map((c) => plain[c] ?? c).join(", ")),
      escape(needs.length ? needs.join("; ") : "just a key"),
      termsCell(entry.terms),
      "",
    ].join(" | ").trim());
  }
  return lines.join("\n");
}

function notes(catalog) {
  const rows = [...catalog.services]
    .filter((entry) => (entry.extras ?? []).length || entry.modelsPath === null || entry.terms.warning)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return rows.map((entry) => `- **${entry.name}** — ${entry.note}${entry.terms.warning ? ` ${entry.terms.warning}` : ""}`).join("\n");
}

const catalog = JSON.parse(await readFile(resolve("data/providers.json"), "utf8"));
const rawBlock = [
  start,
  "",
  // The breakdown is read the same way tests/docs-counts.test.mjs reads it, so the two cannot disagree.
  `Branch knows ${catalog.services.length} model services (${catalog.services.filter((s) => s.kind === "cloud" && s.id !== "custom").length} online, `
    + `${catalog.services.filter((s) => s.kind === "local").length} that run on this computer, and one address of your own). Every one of them has been tested against a fake of the`,
  "service, not against the real one, so treat this as \"Branch speaks the right language\", not as",
  "\"this was tried on a live account\". Addresses and prices were last checked on " + catalog.pricedAt + ".",
  "",
  table(catalog),
  "",
  "Services that need something more than a key, or that do not publish a list of their models:",
  "",
  notes(catalog),
  "",
  end,
].join("\n");

const path = resolve("docs/configuration.md");
const doc = await readFile(path, "utf8");
// Match the line endings the file already uses, so a Windows checkout does not regenerate forever.
const newline = doc.includes("\r\n") ? "\r\n" : "\n";
const block = rawBlock.replace(/\r?\n/g, newline);
const from = doc.indexOf(start), to = doc.indexOf(end);
if (from < 0 || to < 0) {
  console.error(`docs/configuration.md is missing the ${start} / ${end} markers`);
  process.exit(1);
}
const updated = doc.slice(0, from) + block + doc.slice(to + end.length);
if (updated === doc) {
  console.log("docs/configuration.md is already up to date");
} else {
  await writeFile(path, updated);
  console.log(`docs/configuration.md updated with ${catalog.services.length} services`);
}
