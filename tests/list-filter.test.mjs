import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { LongListFilter, registerListRecovery } from "../dist/list-filter.js";
import { DecisionSettingsSchema } from "../dist/decision-models.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, answer = { keep: [1], confidence: 0.95 }) {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "lists-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = app.store.createRun(app.runtime.owner, "Find the invoice file");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = { ...app.runtime.context({ runId: run.id, permissions: ["files.read", "web.read", "personal.read"] }), trunk: "test-trunk" };
  let asked = 0, settings = DecisionSettingsSchema.parse({ filterLists: true });
  const filter = new LongListFilter({ store: app.store, registry: app.registry, settings: () => settings,
    model: () => app.runtime.models.default, async ask(scoped) {
      assert.equal(scoped, context, "the original task context reaches the decision callback");
      asked++; if (answer instanceof Error) throw answer;
      return { status: "resolved", value: answer, reasked: false };
    } });
  registerListRecovery(app.registry, filter);
  const record = (name, result, id = "list1") => {
    app.store.event(run.id, "tool.started", { name, id });
    app.store.event(run.id, "tool.completed", { name, id, result });
    return { name, id, arguments: JSON.stringify({ path: "." }) };
  };
  return { app, run, context, root, filter, record, asked: () => asked,
    settings: (value) => { settings = DecisionSettingsSchema.parse(value); } };
}
const entries = Array.from({ length: 12 }, (_, i) => ({ name: i ? `other-${i}.txt` : "invoice.txt", kind: "file" }));

test("a filtered real file listing retains its full original record and recovers every omitted entry", async (t) => {
  const f = await fixture(t);
  for (const entry of entries) await writeFile(join(f.root, "workspace", entry.name), "isolated fixture");
  const original = await f.app.files.list(".");
  const call = f.record("files.list", original);
  const shown = await f.filter.filter(call, f.context, original, { path: "." });
  assert.equal(shown.entries.length, 1);
  assert.equal(shown.listFilter.originalCount, 12);
  assert.equal(shown.listFilter.recovery.tool, "lists.files_all");
  assert.deepEqual(f.app.store.events(f.run.id).find((e) => e.kind === "tool.completed").data.result, original,
    "the receipt's original result was not replaced by the filtered view");
  assert.deepEqual(await f.app.registry.execute("lists.files_all", { callId: call.id }, f.context), original);
  assert.equal(f.filter.target(call.id, f.context, "files.read"), ".");
  assert.equal(f.asked(), 1);
});

test("disabled, non-Trunk, outside, household and narrowed task scope leave the original list untouched", async (t) => {
  const f = await fixture(t), original = { entries }, call = f.record("files.list", original);
  f.settings({});
  assert.equal(await f.filter.filter(call, f.context, original, {}), original);
  f.settings({ filterLists: true });
  assert.equal(await f.filter.filter(call, { ...f.context, trunk: undefined }, original, {}), original);
  assert.equal(await f.filter.filter(call, { ...f.context, permissions: new Set(["web.read"]) }, original, {}), original);
  for (const marks of [{ source: "channel" }, { source: "owner", personProfileId: "a-person" }, { source: "owner", shortLivedKey: true }]) {
    const run = f.app.store.createRun(f.app.runtime.owner, "other task"); f.app.store.event(run.id, "run.started", marks);
    assert.equal(await f.filter.filter(call, { ...f.context, runId: run.id }, original, {}), original);
  }
  assert.equal(f.asked(), 0);
});

test("uncertain, invalid, empty or failed decisions retain everything, including long entries and duplicate call ids", async (t) => {
  for (const answer of [{ keep: [1], confidence: 0.5 }, { keep: [99], confidence: 1 }, { keep: [], confidence: 1 },
    { keep: [1, 1], confidence: 1 }, new Error("model unavailable")]) {
    const f = await fixture(t, answer), original = { entries }, call = f.record("files.list", original);
    assert.equal(await f.filter.filter(call, f.context, original, {}), original);
  }
  const f = await fixture(t), long = { entries: entries.map((entry) => ({ ...entry, notes: "x".repeat(501) })) };
  const call = f.record("files.list", long);
  assert.equal(await f.filter.filter(call, f.context, long, {}), long);
  f.record("files.list", long);
  const ambiguous = { entries };
  assert.equal(await f.filter.filter(call, f.context, ambiguous, {}), ambiguous);
});

test("recovery cannot read a different task or owner, the wrong source, narrowed permission, or an ambiguous record", async (t) => {
  const f = await fixture(t), original = { entries }, call = f.record("files.list", original);
  await f.filter.filter(call, f.context, original, { path: "." });
  const other = f.app.store.createRun(f.app.runtime.owner, "another task");
  for (const [context, permission] of [[{ ...f.context, runId: other.id }, "files.read"],
    [{ ...f.context, owner: "other-owner" }, "files.read"], [f.context, "web.read"],
    [{ ...f.context, permissions: new Set() }, "files.read"]]) assert.throws(() => f.filter.recover(call.id, context, permission));
  f.record("files.list", original);
  assert.throws(() => f.filter.recover(call.id, f.context, "files.read"));
});

test("mail and web recover their own original shapes without borrowing another source's permission", async (t) => {
  for (const [name, field, permission, recover] of [["mail.search", "messages", "personal.read", "lists.mail_all"],
    ["web.search", null, "web.read", "lists.web_all"]]) {
    const f = await fixture(t);
    const original = field ? { note: "outside text", [field]: entries } : entries;
    const call = f.record(name, original);
    const shown = await f.filter.filter(call, f.context, original, { query: "invoice" });
    assert.equal(shown.listFilter.recovery.tool, recover);
    assert.equal(shown.listFilter.shownCount, 1);
    assert.deepEqual(await f.app.registry.execute(recover, { callId: call.id }, f.context), original);
    assert.throws(() => f.filter.recover(call.id, f.context, "files.read"));
    assert.equal(f.asked(), 1);
  }
});
