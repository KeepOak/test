/* A stand-in for Ollama's own API on 127.0.0.1:11434, for timing the first-task path on a computer without Ollama.
   It answers every route the engine calls (src/local-models.ts OllamaClient, src/providers/ollama.ts):
   version, tags, show, pull (streamed progress), create, generate, ps, delete and chat.
   The model is a script, not a model: it is only a test double. Everything else in the timed path (the engine's tools,
   its approvals, the files that move) is real.
   Chat script, from the conversation so far:
     - a hello (the setup's test): "Hello!"
     - a tidy request with no tool result yet: one tool call that lists the folder
     - a listing came back: a plan in words, then one tool call per move (each waits for the owner's yes)
     - every move answered: a short summary built from the tool results
   Run: node design/redesign/tools/fake-ollama.cjs [--log <file>] (PULL_MS=<ms> stretches the download). */

const http = require("node:http");
const fs = require("node:fs");

const PORT = Number(process.env.FAKE_OLLAMA_PORT || 11434);
const PULL_MS = Number(process.env.PULL_MS || 1500);
const logAt = process.argv.includes("--log") ? process.argv[process.argv.indexOf("--log") + 1] : null;
const models = new Map(); // name -> { size }
const log = (entry) => { if (logAt) fs.appendFileSync(logAt, JSON.stringify(entry) + "\n"); };

const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((done) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { try { done(JSON.parse(s || "{}")); } catch { done({}); } }); });
const tagOf = (name) => (name.includes(":") ? name : `${name}:latest`);

function tags() {
  return { models: [...models].map(([name, m]) => ({ name, model: name, size: m.size, modified_at: new Date().toISOString(),
    details: { family: "qwen3", parameter_size: "4B", families: ["qwen3"] } })) };
}

async function pull(req, res) {
  const body = await read(req);
  const name = tagOf(body.model || body.name);
  const total = 2_600_000_000, steps = 20;
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, PULL_MS / steps));
    res.write(JSON.stringify({ status: "pulling", digest: "sha256:fake", total, completed: Math.round((total * i) / steps) }) + "\n");
  }
  models.set(name, { size: total });
  res.end(JSON.stringify({ status: "success" }) + "\n");
}

/* ---------- the scripted model ---------- */
const toolNames = (tools) => (tools || []).map((t) => t.function?.name).filter(Boolean);
const pick = (names, ...wanted) => wanted.find((w) => names.includes(w)) || null;
let folder = process.env.TIDY_DIR || "";

function reply(body) {
  const msgs = body.messages || [];
  const users = msgs.filter((m) => m.role === "user");
  const last = String(users[users.length - 1]?.content || "");
  const names = toolNames(body.tools);
  const results = msgs.filter((m) => m.role === "tool");
  log({ at: Date.now(), tools: names, user: last.slice(0, 200), results: results.length });
  if (!/tidy|downloads/i.test(last)) return { content: "Hello! I'm ready to help." };
  return tidy(names, msgs, results);
}

function tidy(names, msgs, results) {
  const run = pick(names, "shell_session_run", "shell.session.run", "shell_run", "shell.run");
  const open = pick(names, "shell_session_open", "shell.session.open");
  if (!run) return { content: `I can't reach that folder with the tools I have (${names.slice(0, 12).join(", ")}).` };
  const calls = msgs.flatMap((m) => m.tool_calls || []);
  const madeSession = calls.some((c) => c.function?.name === open);
  const sessionId = sessionFrom(results);
  if (open && !madeSession) return { calls: [{ name: open, arguments: {} }] };
  const listed = calls.some((c) => /Get-ChildItem/.test(JSON.stringify(c.function?.arguments || {})));
  const args = (command) => ({ ...(sessionId ? { sessionId } : {}), command });
  if (!listed) return { calls: [{ name: run, arguments: args(`Get-ChildItem -File -LiteralPath '${folder}' | Select-Object -ExpandProperty Name`) }] };
  const files = filesFrom(results);
  const moves = calls.filter((c) => /Move-Item/.test(JSON.stringify(c.function?.arguments || {})));
  if (!moves.length) {
    const plan = planFor(files);
    if (!plan.length) return { content: "Your Downloads folder has no loose files, so there is nothing to tidy." };
    const words = plan.map(([kind, list]) => `- ${kind}: ${list.join(", ")}`).join("\n");
    const cmd = plan.map(([kind, list]) => `New-Item -ItemType Directory -Force -Path '${folder}\\${kind}' | Out-Null; ${list.map((f) => `Move-Item -LiteralPath '${folder}\\${f}' -Destination '${folder}\\${kind}'`).join("; ")}`).join("; ");
    return { content: `Here's my plan. I'll sort the loose files into folders by kind:\n${words}\nNothing moves until you say yes.`, calls: [{ name: run, arguments: args(cmd) }] };
  }
  return { content: `Done. Your Downloads folder is tidy: ${files.length} files sorted into folders.` };
}

function sessionFrom(results) {
  for (const r of results) { const m = /"?(?:sessionId|id)"?\s*[:=]\s*"?([A-Za-z0-9_-]{6,})/.exec(String(r.content)); if (m) return m[1]; }
  return "";
}
function filesFrom(results) {
  const text = results.map((r) => String(r.content)).join("\n");
  return [...new Set(text.split(/\\n|\n/).map((l) => l.trim().replace(/^"|"$/g, "")).filter((l) => /^[\w .()-]+\.[A-Za-z0-9]{1,5}$/.test(l)))];
}
const KINDS = [["Pictures", /\.(png|jpe?g|gif|webp|heic)$/i], ["Documents", /\.(pdf|docx?|txt|md|xlsx?|csv|pptx?)$/i], ["Installers", /\.(exe|msi|zip|7z|dmg)$/i], ["Audio and video", /\.(mp3|wav|mp4|mov|mkv)$/i]];
function planFor(files) {
  const groups = new Map();
  for (const f of files) { const kind = (KINDS.find(([, re]) => re.test(f)) || ["Other"])[0]; groups.set(kind, [...(groups.get(kind) || []), f]); }
  return [...groups];
}

async function chat(req, res) {
  const body = await read(req);
  if (process.env.TIDY_DIR) folder = process.env.TIDY_DIR;
  const out = reply(body);
  const message = { role: "assistant", content: out.content || "", ...(out.calls ? { tool_calls: out.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}) };
  const done = { model: body.model, done: true, prompt_eval_count: 50, eval_count: 20 };
  if (body.stream === false) return send(res, 200, { model: body.model, message, ...done });
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(JSON.stringify({ model: body.model, message, done: false }) + "\n");
  res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, ...done }) + "\n");
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (path === "/api/version") return send(res, 200, { version: "0.12.0" });
    if (path === "/api/tags") return send(res, 200, tags());
    if (path === "/api/ps") return send(res, 200, { models: [] });
    if (path === "/api/show") { const b = await read(req); return models.has(tagOf(b.model || "")) || models.has(b.model) ? send(res, 200, { details: { family: "qwen3", parameter_size: "4B", families: ["qwen3"] }, model_info: { "qwen3.context_length": 40960 }, capabilities: ["completion", "tools"] }) : send(res, 404, { error: "model not found" }); }
    if (path === "/api/pull") return pull(req, res);
    if (path === "/api/create") { const b = await read(req); models.set(tagOf(b.model), { size: models.get(tagOf(b.from))?.size || 1 }); return send(res, 200, { status: "success" }); }
    if (path === "/api/generate") { await read(req); return send(res, 200, { done: true, response: "" }); }
    if (path === "/api/delete") { const b = await read(req); models.delete(tagOf(b.model)); return send(res, 200, {}); }
    if (path === "/api/chat") return chat(req, res);
    send(res, 404, { error: `no route ${path}` });
  } catch (error) { send(res, 500, { error: String(error) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`fake ollama on 127.0.0.1:${PORT}`));
