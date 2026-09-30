/* A stand-in model service for verify-settings-decisions.cjs only, on this computer, answering the OpenAI-style routes a
   "custom" connection uses. A decision's score question is answered 9 for a deadline or money and 2 otherwise; a pick is
   answered with the choice named after "PICK:" in the message; a task whose message holds "RUN <words>" writes <words>.txt in the
   workspace (started in Ask first, it waits for the owner's yes and lands in Inbox › Needs you). Nothing leaves this computer.
   start(port) returns { port, close }. */
const http = require("node:http");

const text = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
function reply(input) {
  const all = (input.messages ?? []).map(text).join("\n"), last = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
  if (/Give a score from 1 to 10/.test(all)) return { text: JSON.stringify({ score: /due|invoice|\$/i.test(text(last)) ? 9 : 2, confidence: 0.9, why: "" }) };
  const pick = /PICK:(\w+)/.exec(all);
  if (/Pick exactly one/.test(all)) return { text: JSON.stringify({ choice: pick ? pick[1] : "nobody", confidence: 0.95, why: "" }) };
  const run = /RUN ([\w-]+)/.exec(text(last));
  const answered = input.messages?.at(-1)?.role === "tool";
  const tool = (input.tools ?? []).find((t) => t.function?.name === "files.write")?.function?.name;
  if (run && !answered && tool) return { tool, args: JSON.stringify({ path: `${run[1]}.txt`, content: run[1] }) };
  return { text: `stub answers: ${text(last).slice(0, 60)}` };
}

function start(port = 0) {
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
      const message = r.tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_d", type: "function", function: { name: r.tool, arguments: r.args } }] } : { role: "assistant", content: r.text };
      if (!input.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: input.model, choices: [{ index: 0, message, finish_reason: r.tool ? "tool_calls" : "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk(r.tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_d", type: "function", function: { name: r.tool, arguments: r.args } }] } : { role: "assistant", content: r.text }));
      res.write(chunk({}, r.tool ? "tool_calls" : "stop", { usage }));
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } }));
  });
}

module.exports = { start };
