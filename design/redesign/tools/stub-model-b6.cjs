/* A stand-in model service for verify-parity-b6.cjs only: it answers the OpenAI-style routes a "custom" connection uses,
   on this computer, so a throwaway engine has real tasks to show. A message holding "SLOW" is answered after a wait
   (the task is running meanwhile: the list's ring, "N running", Team's count); a message holding "ASK" is answered with
   the engine's own "ask the person a question" tool (a task waiting on you: the copper dot and the notification card);
   "WRITE" writes one file in the workspace (a file a conversation made, for the search). Nothing leaves this computer. start(port) returns { port, close }. */
const http = require("node:http");

const lastUser = (messages) => [...(messages ?? [])].reverse().find((m) => m.role === "user");
const words = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

function reply(input) {
  const messages = input.messages ?? [], asked = words(lastUser(messages));
  const answered = messages.at(-1)?.role === "tool";
  const by = (re) => (input.tools ?? []).find((t) => re.test(t.function?.description ?? ""))?.function?.name;
  if (/ASK/.test(asked) && !answered && by(/ask the person a question/i)) return { tool: by(/ask the person a question/i), args: JSON.stringify({ question: "Which folder should the parity notes go in?" }) };
  if (/WRITE/.test(asked) && !answered && by(/^Write a UTF-8 workspace file/)) return { tool: by(/^Write a UTF-8 workspace file/), args: JSON.stringify({ path: "parity-b6-notes.txt", content: "parity b6" }) };
  return { text: `stub answers: ${asked.slice(0, 60)}`, wait: /SLOW/.test(asked) && !answered ? 20000 : 0 };
}

function start(port = 0) {
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
      const input = JSON.parse(body || "{}"), r = reply(input), usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      const message = r.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_b6", type: "function", function: { name: r.tool, arguments: r.args } }] }
        : { role: "assistant", content: r.text };
      const send = () => {
        if (!input.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: input.model, choices: [{ index: 0, message, finish_reason: r.tool ? "tool_calls" : "stop" }], usage }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
        if (r.tool) res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_b6", type: "function", function: { name: r.tool, arguments: r.args } }] }));
        else res.write(chunk({ role: "assistant", content: r.text }));
        res.write(chunk({}, r.tool ? "tool_calls" : "stop", { usage }));
        res.end("data: [DONE]\n\n");
      };
      if (!r.wait) return send();
      const timer = setTimeout(() => { timers.delete(timer); send(); }, r.wait);
      timers.add(timer);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, close: () => { for (const t of timers) clearTimeout(t); server.closeAllConnections?.(); server.close(); } }));
  });
}

module.exports = { start };
if (require.main === module) start(Number(process.argv[2] ?? 0)).then(({ port }) => console.log(`stub model on ${port}`));
