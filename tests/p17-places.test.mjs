/**
 * p17 places: the two engine reads the redesigned window's Library › Documents needed.
 *
 *   - Ask a spreadsheet (POST /api/data/ask): one read-only question over one spreadsheet in the owner's library,
 *     opened from its workspace file and answered in one call.
 *   - Ask the map (POST /api/knowledge/graph/names): the names a knowledge base's map mentions most, to start from.
 *
 * Mutation notes:
 *   - In src/data-ask.ts, drop the `!doc.filePath` refusal and "a pasted document says there is no file" goes red; drop
 *     the `askableFile` check and "a document that is not a spreadsheet is refused" goes red; replace queryTables with a
 *     hand-written loop that ignores the SQL and the "grouped totals" assertion goes red.
 *   - In src/knowledge-graph.ts `names`, remove the `linksOf(...).length > 0` filter and "only names with a visible link"
 *     goes red; remove the ORDER BY mentions and "most-mentioned first" goes red.
 *   - Take either row out of tests/short-lived-key-routes.mjs and the table assertions go red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { askSpreadsheet } from "../dist/data-ask.js";
import { offLimitsToShortLivedKeys } from "../dist/server.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

const provider = { name: "p17-fixture", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function fixture(t) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-p17-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, workspace };
}
const CSV = "date,payee,category,amount\n2026-09-02,Paper Co,Supplies,412\n2026-09-05,Air,Travel,612\n2026-09-09,Cafe,Meals,48.4\n2026-09-11,Rail,Travel,100\n";
const ask = (app, input) => askSpreadsheet({ documents: app.documents.list("local"), tables: app.dataTables }, input);

test("p17 ask a spreadsheet: one read-only question over a library spreadsheet, answered from its file", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "money"), { recursive: true });
  await writeFile(join(workspace, "money/expenses.csv"), CSV);
  const doc = await app.documents.add("local", { path: "money/expenses.csv" });
  const answer = await ask(app, { document: doc.id, sql: "SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC" });
  assert.equal(answer.table, "expenses");
  assert.deepEqual(answer.columns, ["category", "total"]);
  assert.deepEqual(answer.rows, [["Travel", 712], ["Supplies", 412], ["Meals", 48.4]], "grouped totals, as SQL worked them out");
  assert.equal(answer.truncated, false);
  const limited = await ask(app, { document: doc.id, sql: "SELECT payee FROM expenses", limit: 2 });
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.truncated, true, "it says when there were more rows than it sent");
  await assert.rejects(ask(app, { document: doc.id, sql: "DELETE FROM expenses" }), /Only questions that start with SELECT or WITH/);
  await assert.rejects(ask(app, { document: doc.id, sql: "SELECT 1; DROP TABLE expenses" }), /one question at a time/);
  assert.equal(await readFile(join(workspace, "money/expenses.csv"), "utf8"), CSV, "the file is never written");
});

test("p17 ask a spreadsheet: a pasted document, a document that is not a spreadsheet and an unknown id say so", async (t) => {
  const { app, workspace } = await fixture(t);
  const pasted = await app.documents.add("local", { name: "pasted.csv", text: CSV });
  await assert.rejects(ask(app, { document: pasted.id, sql: "SELECT 1" }), /pasted or uploaded, so there is no file to open/);
  await writeFile(join(workspace, "notes.md"), "# Notes\n\nNothing tabular here.\n");
  const notes = await app.documents.add("local", { path: "notes.md" });
  await assert.rejects(ask(app, { document: notes.id, sql: "SELECT 1" }), /is not a spreadsheet/);
  await assert.rejects(ask(app, { document: "00000000-0000-4000-8000-000000000000", sql: "SELECT 1" }), /no document with that id/);
  await assert.rejects(ask(app, { document: notes.id, sql: "" }), /sql/);
});

test("p17 ask the map: the most-mentioned names that have a link, each one the map can answer about", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "kb"), { recursive: true });
  await writeFile(join(workspace, "kb/one.md"), "# Suppliers\n\nOakfield Supply quoted Brightline Paper prices. Oakfield Supply delivers to Harbour Office.\n");
  await writeFile(join(workspace, "kb/two.md"), "# Travel\n\nOakfield Supply and Harbour Office share a loading dock near Harbour Office.\n");
  const base = app.knowledgeParts.bases.create("local", { name: "Work", sources: [{ kind: "folder", path: "kb" }] });
  await app.knowledgeParts.bases.reindex("local", base.id);
  await app.knowledgeParts.graph.build("local", base.id, false);
  const { names } = app.knowledgeParts.graph.names("local", { collection: base.id, limit: 5 });
  assert.ok(names.length > 0, "a built map offers names");
  assert.ok(names.length <= 5, "no more than asked for");
  for (let i = 1; i < names.length; i++) assert.ok(names[i - 1].mentions >= names[i].mentions, "most-mentioned first");
  for (const one of names) {
    const around = app.knowledgeParts.graph.neighbourhood("local", { collection: base.id, entity: one.name });
    assert.equal(around.found, true, `${one.name} is found`);
    assert.ok(around.links.length > 0, `only names with a visible link are offered (${one.name})`);
  }
  assert.throws(() => app.knowledgeParts.graph.names("local", { collection: base.id, limit: 0 }));
});

test("p17 ask the map: a name read only from a file a rule refuses is not offered", async (t) => {
  const { app, workspace } = await fixture(t);
  await mkdir(join(workspace, "finance"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "finance/deal.md"), "# Deal\n\nAcme Holdings paid Zenith Partners.\n");
  await writeFile(join(workspace, "notes/plan.md"), "# Plan\n\nOakfield Supply delivers to Harbour Office.\n");
  const base = app.knowledgeParts.bases.create("local", { name: "Everything", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeParts.bases.reindex("local", base.id);
  await app.knowledgeParts.graph.build("local", base.id, false);
  const offered = () => app.knowledgeParts.graph.names("local", { collection: base.id, limit: 40 }).names.map((one) => one.name);
  assert.ok(offered().includes("Zenith Partners"), `before the rule (control): ${offered().join(", ")}`);
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision: "deny", remember: "always", resource: { kind: "path", pattern: "finance" } });
  assert.ok(!offered().includes("Zenith Partners"), "only names with a visible link are offered");
  assert.ok(offered().includes("Harbour Office"), "names from files the owner may see still are");
});

test("p17 both routes are written down for short-lived keys, and asking a spreadsheet is the owner's", () => {
  assert.equal(ROUTES["/api/data/ask"], "owner POST");
  assert.ok(offLimitsToShortLivedKeys("POST", "/api/data/ask"), "a short-lived key cannot open the owner's workspace files");
  assert.equal(ROUTES["/api/knowledge/graph/names"], "other POST");
  assert.ok(offLimitsToShortLivedKeys("POST", "/api/knowledge/graph/names"), "a read taken through POST is still refused, as /api/knowledge/graph is");
});
