#!/usr/bin/env node
/**
 * CHAT-003: writes the "Tested for real" table in docs/chat-parity.md from tests/real-chat-apps.mjs, in the setup
 * catalog's order. tests/real-chat.test.mjs checks the doc matches, so the table cannot drift from the harness.
 *
 *   node scripts/real-chat/table.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCAL, SKIPPED } from "../../tests/real-chat-apps.mjs";

const root = new URL("../../", import.meta.url);
export const docPath = fileURLToPath(new URL("docs/chat-parity.md", root));
export const START = "<!-- real-chat:start (written by node scripts/real-chat/table.mjs) -->";
export const END = "<!-- real-chat:end -->";

/** The table, one row per app in the setup catalog. */
export function realChatTable() {
  const recipes = JSON.parse(readFileSync(new URL("data/channel-setup.json", root), "utf8")).recipes;
  const rows = recipes.map(({ id, name }) => LOCAL[id]
    ? `| ${name} | **Real-tested** | ${LOCAL[id]} |`
    : `| ${name} | Skipped | ${SKIPPED[id] ?? "no reason given (the harness test fails on this)"} |`);
  const tested = recipes.filter(({ id }) => LOCAL[id]).length;
  return [START, "",
    `${tested} of ${recipes.length} apps are tested for real; every other one says why not.`, "",
    "| App | Result | Server, or why not |", "| --- | --- | --- |", ...rows, "", END].join("\n");
}
/** The doc with its table section replaced by the current one. */
export function withTable(doc) {
  const from = doc.indexOf(START), to = doc.indexOf(END);
  if (from === -1 || to === -1) throw new Error(`docs/chat-parity.md has no ${START} ... ${END} section`);
  return doc.slice(0, from) + realChatTable() + doc.slice(to + END.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const doc = readFileSync(docPath, "utf8");
  writeFileSync(docPath, withTable(doc));
  console.log("Wrote the real-chat table in docs/chat-parity.md");
}
