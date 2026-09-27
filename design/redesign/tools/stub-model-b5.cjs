/* A stand-in model service for verify-parity-b5.cjs only: it answers the OpenAI-style routes a "custom" connection uses,
   on a free port on this computer, so a throwaway engine has two connections for the arena, an account that bills per use
   for the spend caps, a run for the usage report and a reply to flag. Each answer names the model that gave it; nothing
   leaves this computer. Start it with start(); it returns { port, close }. */
const http = require("node:http");

function answer(model, messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  const asked = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  return `${model} answers: ${asked.slice(0, 80)}`;
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
      if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
        const input = JSON.parse(body || "{}");
        const text = answer(input.model ?? "stub-model", input.messages);
        const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
        if (input.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
          res.write(chunk({ role: "assistant", content: text }));
          res.write(chunk({}, "stop", { usage }));
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: input.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not here" } }));
    });
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })); });
}

module.exports = { start };
if (require.main === module) start(Number(process.argv[2] ?? 0)).then(({ port }) => console.log(`stub model on ${port}`));
