/**
 * The nightly run's own pieces, without a model or a network: the page that puts a night's models side by side, and the
 * SSH forward refusing a local port that is already taken (checked before the vault or the network is touched).
 *   node --test evals/nightly.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { scorecardJson, sideBySideMarkdown } from "./lib/report.mjs";
import { openTunnel } from "./lib/tunnel.mjs";

const card = (label, statuses) => scorecardJson({
  model: { id: label, label }, host: "h", startedAt: "2026-09-27T07:30:00Z", finishedAt: "2026-09-27T07:35:00Z",
  results: Object.entries(statuses).map(([id, status]) => ({ id, area: "work", title: id, status, ms: 1500 })),
});

test("a night's page shows each model's pass rate and one row per task with every model's status", () => {
  const page = sideBySideMarkdown("2026-09-27", [
    card("Ollama small", { "edit-file": "pass", "mem-forget": "fail", "attach-file": "timeout" }),
    card("Ollama big", { "edit-file": "pass", "mem-forget": "pass" }),
  ], ["[small](small/2026-09-27.md)"]);
  assert.match(page, /\| Ollama small \| \*\*1\/2\*\* \(50%\) \| 300s \| timeout: 1 \|/);
  assert.match(page, /\| Ollama big \| \*\*2\/2\*\* \(100%\) \| 300s \| — \|/);
  assert.match(page, /\| Task \| Area \| Ollama small \| Ollama big \|/);
  assert.match(page, /\| mem-forget \| work \| FAIL · 1\.5s \| PASS · 1\.5s \|/);
  assert.match(page, /\| attach-file \| work \| timeout · 1\.5s \| — \|/, "a task one model did not run is a dash, not a pass");
  assert.match(page, /small\/2026-09-27\.md/);
});

test("a model whose suite could not run is a column that says why, never an empty pass", () => {
  const page = sideBySideMarkdown("2026-09-27", [
    card("Ollama small", { "edit-file": "pass" }),
    { model: { label: "Ollama big" }, missing: "could not reach the GPU box: timed | out" },
  ]);
  assert.match(page, /\| Ollama big \| did not run: could not reach the GPU box: timed \\\| out \| — \| — \|/);
  assert.match(page, /\| edit-file \| work \| PASS · 1\.5s \| — \|/);
});

test("the SSH forward refuses a local port that is already taken, before the vault or the network", async () => {
  const holder = createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address();
  try {
    await assert.rejects(openTunnel({ sshHost: "unused.invalid", sshUser: "nobody", bitwardenItem: "unused", localPort: port }, { timeoutMs: 30_000 }),
      new RegExp(`127\\.0\\.0\\.1:${port} is not free`));
  } finally {
    holder.close();
  }
});
