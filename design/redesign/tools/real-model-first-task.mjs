// End-to-end: a real local model finishes a first task through the engine, in a fresh data folder and workspace.
// Usage, from the repo root after a build:
//   PORT=<free port> node design/redesign/tools/real-model-first-task.mjs [model] [ollama|openai] [tag]
// TASK=edit (the default): "Read list.txt and add milk to it as a new line."; list.txt is checked on disk.
// TASK=tidy: the showcase, "Tidy my Downloads folder", in a fixture home (the engine's HOME and USERPROFILE) whose
//   Downloads holds a few loose files. A question is answered yes only when it names that fixture folder; the files are
//   checked on disk afterwards.
// ENDPOINT=<http://127.0.0.1:port/v1> points the openai kind at another server (a forwarded port); the ollama kind uses
// Ollama's own address. The connection goes to a model the server already has: nothing is pulled, created or removed.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const [model = "qwen2.5:7b-branch8k", kind = "ollama", tag = "a"] = process.argv.slice(2);
const task = process.env.TASK ?? "edit";
const lane = process.env.OUT_DIR ?? (await import("node:os")).tmpdir();
const root = join(lane, `e2e-${tag}-${Date.now()}`);
const data = join(root, "data"), ws = join(root, "workspace"), home = join(root, "home"), downloads = join(home, "Downloads");
for (const dir of [data, ws, downloads, join(home, "Desktop"), join(home, "Documents")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(ws, "list.txt"), "eggs\nbread\n");
// No .exe, .dll or .node file is ever made on the owner's PC (Smart App Control), not even a text one: the archive stands in.
const loose = ["invoice-march.pdf", "holiday.jpg", "setup-tool.zip", "notes.txt", "song.mp3", "screenshot.png"];
for (const name of loose) writeFileSync(join(downloads, name), `fixture ${name}\n`);
const env = { ...process.env, BRANCH_DATA_DIR: data, BRANCH_PORT: process.env.PORT ?? "3402", BRANCH_WORKSPACE: ws };
if (task === "tidy") Object.assign(env, { HOME: home, USERPROFILE: home });
delete env.BRANCH_PROVIDER;
if (kind === "openai") Object.assign(env, { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: process.env.ENDPOINT ?? "http://127.0.0.1:11434/v1", BRANCH_MODEL: model, BRANCH_API_KEY: "local" });
const engine = spawn(process.execPath, ["dist/cli.js", "start"], { cwd: process.cwd(), env });
let out = "";
const token = await new Promise((ok, no) => {
  const timer = setTimeout(() => no(new Error("no token: " + out)), 90000);
  const hear = (d) => { out += d; const m = /Local session token \(paste into browser\): ([0-9a-f]+)/.exec(out); if (m) { clearTimeout(timer); ok(m[1]); } };
  engine.stdout.on("data", hear); engine.stderr.on("data", hear);
});
console.log("engine pid", engine.pid);
const api = async (path, body, method = body ? "POST" : "GET") => {
  const r = await fetch(`http://127.0.0.1:${env.BRANCH_PORT}` + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Answers each question: yes only when it names the fixture's Downloads folder, for this conversation. */
async function answerUntilDone(first) {
  let run = first, asked = 0;
  const seen = new Set(), until = Date.now() + 300_000;
  while (Date.now() < until) {
    const state = await api("/api/state");
    run = (state.runs ?? []).filter((r) => r.sessionId === first.sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? run;
    const waiting = ((await api("/api/policy")).waiting ?? []).filter((q) => q.sessionId === first.sessionId && !seen.has(q.fingerprint));
    for (const q of waiting) {
      seen.add(q.fingerprint);
      asked++;
      const yes = JSON.stringify(q).includes(JSON.stringify(downloads).slice(1, -1));
      console.log(`question ${asked}: ${yes ? "yes" : "no"} · ${String(q.question ?? q.label ?? "").slice(0, 160)}`);
      await api("/api/policy/approve", { sessionId: q.sessionId, decision: yes ? "allow" : "deny", remember: "session", fingerprint: q.fingerprint, carryOn: true });
    }
    if (!waiting.length && ["completed", "failed", "cancelled"].includes(run.status)) return { run, asked };
    await sleep(500);
  }
  return { run, asked };
}
try {
  if (kind === "ollama") console.log("connect:", (await api("/api/connections/from-preset", { provider: "ollama", model })).message);
  const started = Date.now();
  const prompt = task === "tidy" ? "Tidy my Downloads folder" : "Read list.txt and add milk to it as a new line.";
  const first = await api("/api/run", { prompt, mode: process.env.MODE ?? "auto" });
  const { run, asked } = task === "tidy" ? await answerUntilDone(first) : { run: first, asked: 0 };
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const runIds = ((await api("/api/state")).runs ?? []).filter((r) => r.sessionId === first.sessionId).map((r) => r.id);
  engine.kill(); await new Promise((ok) => engine.once("exit", ok));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(data, "branch.sqlite"), {});
  for (const id of runIds.length ? runIds : [run.id]) {
    const list = db.prepare("SELECT kind, data FROM events WHERE run_id=? ORDER BY id").all(id).map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
    console.log(list.filter((e) => /^(tool\.(started|failed|unoffered)|model\.(dropped_call|empty_reply|announced_only)|policy\.(ask|denied))$/.test(e.kind))
      .map((e) => e.kind + " " + JSON.stringify(e.data).slice(0, 180)).join("\n"));
  }
  console.log("STATUS", run.status, secs + "s", task === "tidy" ? `${asked} question(s)` : "");
  console.log("OUTPUT", String(run.output).slice(0, 500));
  if (task === "tidy") {
    const walk = (dir, at = "") => readdirSync(dir).flatMap((name) => statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), `${at}${name}/`) : [`${at}${name}`]);
    const now = walk(downloads);
    const moved = loose.filter((name) => !now.includes(name));
    console.log("DOWNLOADS", JSON.stringify(now));
    console.log("MOVED", `${moved.length}/${loose.length}`, now.length === loose.length ? "nothing lost" : `FILES ${now.length} of ${loose.length}`);
  } else console.log("FILE", JSON.stringify(readFileSync(join(ws, "list.txt"), "utf8")));
} catch (error) { console.log("ERROR", error.message); }
finally { engine.kill(); }
