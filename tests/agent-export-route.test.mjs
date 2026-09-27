/**
 * p17: taking the whole assistant with you from the window (Settings › Data & usage › Moving in and out).
 * GET /api/agent-export says what each part holds; POST writes the one file with only the parts ticked,
 * memory with personal details masked, and never a secret. The owner's alone. A scripted model; no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys, offLimitsToHousehold } from "../dist/server.js";
import { householdRefusal } from "../dist/household-routes.js";
import { openAgent, importAgent } from "../dist/agent-export.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-export-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { app, api, owner: app.runtime.owner };
}

test("GET counts each part the way the file names it, without writing a file or a record", async (t) => {
  const { app, api, owner } = await served(t);
  app.store.save("memory", owner, "fact-1", { text: "Likes green tea", source: "owner" });
  const before = app.store.list("governance", owner).length;
  const { status, body } = await api("GET", "/api/agent-export");
  assert.equal(status, 200);
  assert.deepEqual(body.sections.map((s) => s.name), ["specialists", "procedures", "skills", "routing", "permissions", "memory"]);
  const memory = body.sections.find((s) => s.name === "memory");
  assert.equal(memory.items, 1);
  assert.equal(memory.summary, "1 remembered fact");
  assert.equal(JSON.stringify(body).includes("green tea"), false, "memory is counted, never read out");
  assert.equal(app.store.list("governance", owner).length, before, "looking writes nothing down");
});

test("POST writes only the parts ticked, masks personal details in memory, and records the export", async (t) => {
  const { app, api, owner } = await served(t);
  app.store.save("memory", owner, "fact-1", { text: "Write to sam@example.com about the lease", source: "owner" });
  const { status, body } = await api("POST", "/api/agent-export", { sections: ["skills", "memory"] });
  assert.equal(status, 200);
  const opened = openAgent(Buffer.from(body.data, "base64"));
  assert.deepEqual(opened.manifest.sections.map((s) => s.name), ["skills", "memory"]);
  assert.equal(opened.manifest.memoryRedacted, true);
  const memory = opened.files.get("memory.json");
  assert.equal(memory.includes("sam@example.com"), false, "the address is masked on the way out");
  assert.match(memory, /lease/);
  const exported = app.store.audit.list(owner, { limit: 200 }).find((entry) => entry.action === "data.exported");
  assert.ok(exported, "the export is written into the record");
});

test("POST without memory leaves memory out; a part Branch does not have is refused", async (t) => {
  const { api } = await served(t);
  const { body } = await api("POST", "/api/agent-export", { sections: ["routing", "permissions"] });
  assert.deepEqual(openAgent(Buffer.from(body.data, "base64")).manifest.sections.map((s) => s.name), ["routing", "permissions"]);
  assert.equal((await api("POST", "/api/agent-export", { sections: ["conversations"] })).status, 400);
  assert.equal((await api("POST", "/api/agent-export", { sections: [] })).status, 400);
  assert.equal((await api("POST", "/api/agent-export", { sections: ["skills"], extra: 1 })).status, 400);
});

test("a file exported with memory is brought back in by another Branch, facts and all", async (t) => {
  const { app, api, owner } = await served(t);
  app.store.save("memory", owner, "fact-1", { text: "Likes green tea", source: "owner" });
  const { body } = await api("POST", "/api/agent-export", { sections: ["memory", "skills"] });
  const other = await served(t);
  const reports = importAgent(other.app.store, other.owner, openAgent(Buffer.from(body.data, "base64")), ["memory"]);
  assert.deepEqual(reports.find((r) => r.section === "memory")?.brought, 1);
  assert.equal(other.app.store.exportMemory(other.owner).records.some((r) => r.data.text === "Likes green tea"), true);
});

test("a short-lived key and a household profile are refused the file", () => {
  assert.notEqual(offLimitsToShortLivedKeys("POST", "/api/agent-export"), null);
  assert.equal(offLimitsToHousehold("POST", "/api/agent-export"), householdRefusal);
});

/* Mutation note: removing `if (options.sections && !options.sections.includes(section)) continue;` from
   exportAgent (src/agent-export.ts) makes the second and third tests fail (every section is written);
   dropping the `redact` option in the route makes the second fail (the address leaves unmasked); reading
   `exported.facts` alone again in sectionData (the archive keeps its facts under `records`) makes the first
   two fail (memory counts and carries nothing); handing importMemory `{ facts }` again in bringIn makes the
   round-trip test fail (the archive is refused). */
