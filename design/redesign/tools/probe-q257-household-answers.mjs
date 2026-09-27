// Q257 probe (run from the repo root after npx tsc -p .): each way a household person might answer the owner's waiting
// question, sent as Sam over HTTP, with what it did to the owner's question and task. Port 0; a temporary data folder.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createBranch } = await import("../../../dist/index.js");
const { startServer } = await import("../../../dist/server.js");
const { runForCurrentPerson } = await import("../../../dist/collab-server.js");
const { savePolicy } = await import("../../../dist/policy.js");
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  if (last?.role === "user" && /^write /.test(String(last.content)))
    return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: String(last.content).slice(6).trim(), content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };
const root = await mkdtemp(join(tmpdir(), "q257-probe-"));
const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: writer });
savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
const post = (body) => fetch(server.url + "/api/policy/approve", { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => `${r.status} ${(await r.text()).slice(0, 110)}`);
async function fresh() {
  app.store.profiles.switch({ profileId: null });
  const first = await app.runtime.run({ prompt: "write old.txt" });
  const stale = app.runtime.approvals.questionFor(first.sessionId);
  app.runtime.approve(first.sessionId, "allow", "never", stale.fingerprint);
  const run = await app.runtime.run({ prompt: "write owner.txt", sessionId: first.sessionId });
  return { run, live: app.runtime.approvals.questionFor(run.sessionId), stale };
}
const cases = [
  ["live fingerprint, allow", (s) => ({ fingerprint: s.live.fingerprint, decision: "allow" })],
  ["live fingerprint, deny + carryOn", (s) => ({ fingerprint: s.live.fingerprint, decision: "deny", carryOn: true })],
  ["no fingerprint, allow + carryOn", () => ({ decision: "allow", carryOn: true })],
  ["stale (answered) fingerprint", (s) => ({ fingerprint: s.stale.fingerprint, decision: "allow" })],
  ["made-up fingerprint", () => ({ fingerprint: "0".repeat(32), decision: "allow" })],
];
for (const [name, body] of cases) {
  const setup = await fresh();
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const said = await post({ sessionId: setup.run.sessionId, remember: "never", ...body(setup) });
  app.store.profiles.switch({ profileId: null });
  const still = app.runtime.approvals.questionFor(setup.run.sessionId, setup.live.fingerprint) ? "still waiting" : "ANSWERED";
  console.log(`${name.padEnd(34)} → ${said}  | owner's question: ${still}, task: ${app.store.run(setup.run.id).status}`);
}
await server.close(); await app.close();
await rm(root, { recursive: true, force: true }).catch(() => undefined);
