/* A stand-in model service for the helpers frame (DESIGN-DIRECTION PR 1; the window PRs 4 and 5 use it): it answers the
   OpenAI-style routes a local connection uses, on this computer only, so a throwaway engine has live helpers to show.
   - A message holding "HELPERS" hands work to three helpers at once with the engine's own delegate.parallel tool (the
     specialists seed-helpers.mjs made; their ids come from the file it wrote). When that tool's toolbox is still
     closed, it opens it first with the engine's own "Open a toolbox" tool.
   - Each helper reads notes.txt (a real tool step, so the frame has a newest step), then works for HELPERS_WAIT_MS
     (default 45 s: a model call and a helpers tool call are both cut at 90 s, QA Q053), reads again and answers, so it stays "running" meanwhile and can
     be steered or stopped. A helper steered mid-work reads the note on its next round and says so in its answer.
   Nothing leaves this computer. start(port, idsFile) returns { port, close }.
   Run: node design/redesign/tools/stub-model-helpers.cjs <port> <data dir>/helpers-seed.json */
const http = require("node:http");
const { readFileSync } = require("node:fs");

const words = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
const wait = Number(process.env.HELPERS_WAIT_MS ?? 45000);

function reply(input, seed) {
  const messages = input.messages ?? [], system = words(messages.find((m) => m.role === "system"));
  const firstUser = words(messages.find((m) => m.role === "user")), last = messages.at(-1);
  const tool = (re) => (input.tools ?? []).find((t) => re.test(t.function?.description ?? ""))?.function?.name;
  const helper = /You are the (Researcher|Checker|Writer), a helper\./.exec(system)?.[1];
  if (/^say ready/.test(firstUser)) return { text: "ready" };
  if (helper) {
    const rounds = messages.filter((m) => m.role === "assistant").length;
    const read = tool(/^Read a UTF-8 workspace file/i);
    // Reads, works (the wait), reads again, then answers; a steer note lands before that last round.
    if (rounds < 2 && read) return { tool: read, args: JSON.stringify({ path: "notes.txt" }), wait: rounds === 1 ? wait : 0 };
    const steered = messages.filter((m) => m.role === "user").length > 1;
    return { text: `${helper} finished${steered ? ", as you steered it" : ""}: ${firstUser.slice(0, 60)}` };
  }
  if (!/HELPERS/.test(firstUser)) return { text: `stub answers: ${firstUser.slice(0, 60)}` };
  if (last?.role === "tool" && /"branches"/.test(words(last))) return { text: "All three helpers answered." };
  const parallel = tool(/^Run up to six specialists at once/);
  if (parallel) return { tool: parallel, args: JSON.stringify({ tasks: seed.specialists.map((s) => ({ specialist: s.id, prompt: s.job })) }) };
  const load = tool(/^Load tools you already know the exact names of/);
  if (load && !messages.some((m) => m.role === "tool")) return { tool: load, args: JSON.stringify({ names: ["delegate.parallel"] }) };
  return { text: "The helpers tool is not offered to this conversation." };
}

function start(port = 0, idsFile) {
  const seed = JSON.parse(readFileSync(idsFile, "utf8"));
  const timers = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
      const input = JSON.parse(body || "{}"), r = reply(input, seed), usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      const id = `call_${Math.random().toString(36).slice(2, 10)}`;
      const message = r.tool
        ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: r.tool, arguments: r.args } }] }
        : { role: "assistant", content: r.text };
      const send = () => {
        if (!input.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: input.model, choices: [{ index: 0, message, finish_reason: r.tool ? "tool_calls" : "stop" }], usage }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
        if (r.tool) res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: r.tool, arguments: r.args } }] }));
        else res.write(chunk({ role: "assistant", content: r.text }));
        res.write(chunk({}, r.tool ? "tool_calls" : "stop", { usage }));
        res.end("data: [DONE]\n\n");
      };
      if (!r.wait) return send();
      // A stopped helper's request is closed by the engine: its answer is dropped with it.
      const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) send(); }, r.wait);
      timers.add(timer);
      res.on("close", () => { if (res.writableEnded) return; clearTimeout(timer); timers.delete(timer); });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, close: () => { for (const t of timers) clearTimeout(t); server.closeAllConnections?.(); server.close(); } }));
  });
}

module.exports = { start };
if (require.main === module) start(Number(process.argv[2] ?? 0), process.argv[3]).then(({ port }) => console.log(`helpers stub model on ${port}`));
