// End-to-end: a real local model finishes a first task (read + edit a file) through the engine.
// Usage, from the repo root after a build: PORT=<free port> node design/redesign/tools/real-model-first-task.mjs [model] [ollama|openai] [tag]
// It adds a connection to a model already on Ollama (nothing is pulled, created or removed) and checks list.txt on disk.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const [model = "qwen2.5:7b-branch8k", kind = "ollama", tag = "a"] = process.argv.slice(2);
const lane = process.env.OUT_DIR ?? (await import("node:os")).tmpdir();
const root = join(lane, `e2e-${tag}-${Date.now()}`);
const data = join(root, "data"), ws = join(root, "workspace");
mkdirSync(data, { recursive: true }); mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "list.txt"), "eggs\nbread\n");
const env = { ...process.env, BRANCH_DATA_DIR: data, BRANCH_PORT: process.env.PORT ?? "3402", BRANCH_WORKSPACE: ws };
delete env.BRANCH_PROVIDER;
if (kind === "openai") Object.assign(env, { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: "http://127.0.0.1:11434/v1", BRANCH_MODEL: model, BRANCH_API_KEY: "local" });
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
try {
  if (kind === "ollama") console.log("connect:", (await api("/api/connections/from-preset", { provider: "ollama", model })).message);
  const started = Date.now();
  const run = await api("/api/run", { prompt: "Read list.txt and add milk to it as a new line.", mode: process.env.MODE ?? "auto" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  engine.kill(); await new Promise((ok) => engine.once("exit", ok));
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync } = await import("node:fs");
  const file = "branch.sqlite";
  const db = new DatabaseSync(join(data, file), {});
  const list = db.prepare("SELECT kind, data FROM events WHERE run_id=? ORDER BY id").all(run.id).map((r) => ({ kind: r.kind, data: JSON.parse(r.data) }));
  const kinds = list.filter((e) => /^(tool\.(started|completed|failed|unoffered)|model\.(dropped_call|empty_reply|announced_only|completed)|catalog\.size)$/.test(e.kind))
    .map((e) => e.kind + " " + JSON.stringify(e.data).slice(0, 160));
  console.log(kinds.join("\n"));
  console.log("STATUS", run.status, secs + "s");
  console.log("OUTPUT", String(run.output).slice(0, 400));
  console.log("FILE", JSON.stringify(readFileSync(join(ws, "list.txt"), "utf8")));
} catch (error) { console.log("ERROR", error.message); }
finally { engine.kill(); }
