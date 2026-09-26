// Q259 audit: as a household person at the window, GET every route in the short-lived key table (tests/short-lived-key-routes.mjs)
// and look for the owner's seeded marker strings in each answer. Each ":id" is tried with the owner's task id and with the
// owner's conversation id, the seeded records' ids and a setting key. Run from the repo root after `npx tsc -p .`: node design/redesign/tools/sweep-q259-household-gets.mjs
// It prints every route it asked, the ones whose answer to the owner carries a marker (with Sam's status), and any leak to Sam.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const imp = (path) => import(pathToFileURL(join(process.cwd(), path)).href);
const { createBranch } = await imp("dist/index.js");
const { startServer } = await imp("dist/server.js");
const { savePolicy } = await imp("dist/policy.js");
const { audit } = await imp("dist/audit.js");
const { savePrompt, savePromptLibrarySettings } = await imp("dist/prompt-library.js");
const { saveAssistantIdentity } = await imp("dist/identity.js");
const { ROUTES } = await imp("tests/short-lived-key-routes.mjs");

/** Writes one marked file when asked to, then answers with a marked sentence. */
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  if (last?.role === "user" && /write /.test(String(last.content)))
    return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: "zqmark-owner.txt", content: "zqmark-content" }) }] };
  return { content: "zqmark-answer", toolCalls: [] };
} };
const dir = await mkdtemp(join(tmpdir(), "branch-q259-sweep-"));
const app = await createBranch({ workspace: join(dir, "w"), dataDir: join(dir, "d"), provider: writer });
savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
const server = await startServer(app, { dataDir: join(dir, "d"), port: 0 });
const owner = app.runtime.owner;
const run = await app.runtime.run({ prompt: "zqmark-prompt please write the file" });
app.store.save("memory", owner, "zqmark-fact-id", { text: "zqmark-fact", source: "owner" });
audit(app.store, owner, { action: "secret.used", actor: owner, subject: "zqmark-audit", reason: "zqmark-audit-reason", outcome: "used", runId: run.id });
app.store.review.propose(owner, { kind: "put", text: "zqmark-proposal", source: "zqmark-proposal-source", runId: run.id });
savePromptLibrarySettings(app.store, owner, { mode: "on" });
savePrompt(app.store, owner, { title: "zqmark-prompt-title", body: "zqmark-saved-body", command: "zqmarkcmd" }, () => false);
saveAssistantIdentity(app.store, owner, { name: "Branch Agent", instructions: "zqmark-instructions", expectedRevision: 0 });
for (const table of ["schedules", "triggers", "webhooks", "procedures", "workflows", "specialists"])
  app.store.save(table, owner, `zqmark-${table}`, { name: `zqmark-${table}`, prompt: `zqmark-${table}`, status: "pending", dueAt: new Date().toISOString() });
const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });

// Left out: streams that never end, and anything about closing, removing or updating Branch or driving this computer.
const skip = /remove-branch|uninstall|deployment|quit|restart|update|never-break|comfort|desktop|local-models|voice|dictation|linux-desktop|browser|events$|stream|live$|watch|\/sse|screen|vnc/;
const paths = [];
for (const [written, kind] of Object.entries(ROUTES)) {
  // A few rows are written as patterns: a setting key, a device id, a request id.
  const path = written.replace("[A-Za-z0-9_.:-]{3,160}", "policy.preset").replace("[a-f0-9]{16}", "0".repeat(16)).replace("[a-f0-9]{32}", "0".repeat(32));
  if (kind === "prefix" || kind.startsWith("pre-auth") || !path.startsWith("/api/") || skip.test(path)) continue;
  // Each id the owner has: a task, a conversation, the seeded records by their names, and a setting key.
  if (path.includes(":id")) for (const id of [run.id, run.sessionId, "zqmark-fact-id", "zqmark-schedules", "zqmark-webhooks", "policy.preset"]) paths.push(path.replaceAll(":id", id));
  else paths.push(path);
}
// The same routes with the query words that change what they answer.
paths.push("/api/audit/export.csv", "/api/audit?limit=1000", "/api/commands?surface=window", "/api/commands?surface=phone",
  `/api/sessions/${run.sessionId}/export?format=markdown`, `/api/logs?run=${run.id}`, "/api/activity?waiting=1",
  `/api/runs/${run.id}/trace?format=document`);
const get = async (path) => {
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 3000);
  try {
    const response = await fetch(server.url + path, { headers: { authorization: `Bearer ${server.token}` }, signal: stop.signal });
    return { status: response.status, text: await response.text() };
  } catch (error) { return { status: 0, text: String(error.message) }; } finally { clearTimeout(timer); }
};
const marks = (text) => [...new Set(text.toLowerCase().match(/zqmark-[a-z-]+/g) ?? [])];
const asked = [...new Set(paths)], leaks = [], ownerHas = [], statuses = [], same = [];
for (const path of asked) {
  app.store.profiles.switch({ profileId: null });
  const asOwner = await get(path);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const asSam = await get(path);
  const seen = marks(asOwner.text), leaked = marks(asSam.text);
  const named = path.replaceAll(run.id, ":runId").replaceAll(run.sessionId, ":sessionId");
  statuses.push(`${String(asSam.status).padEnd(3)} ${named}`);
  // Answered to Sam exactly as to the owner: the owner's answer, whatever it holds (a setting, a catalog, a record).
  if (asSam.status === 200 && asOwner.status === 200 && asSam.text === asOwner.text && asSam.text.length > 40) same.push(named);
  if (seen.length) ownerHas.push(`${path} owner:${asOwner.status} sam:${asSam.status} ${seen.join(",")}`);
  if (leaked.length) leaks.push(`${path} sam:${asSam.status} ${leaked.join(",")}`);
}
app.store.profiles.switch({ profileId: null });
if (process.argv.includes("--all")) {
  console.log(`--- every route asked, with Sam's status ---\n${statuses.join("\n")}`);
  console.log(`--- answered to Sam byte for byte as to the owner ---\n${same.join("\n")}`);
}
console.log(`routes asked: ${asked.length}`);
console.log(`--- owner answers carrying a marker (and Sam's status) ---\n${ownerHas.join("\n")}`);
console.log(`--- leaks to Sam ---\n${leaks.join("\n") || "(none)"}`);
await server.close(); await app.close(); await rm(dir, { recursive: true, force: true }).catch(() => undefined);
process.exit(leaks.length ? 1 : 0);
