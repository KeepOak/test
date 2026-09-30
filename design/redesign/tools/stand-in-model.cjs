// An OpenAI-shaped model on this computer for the verify tools (the demo model left in #359): it lists one model and
// answers every chat with the same words, streamed or not, on 127.0.0.1:1234, where the catalog's LM Studio line is
// reached (src/local-connection-policy.ts). Add it with POST /api/connections/from-preset { provider: "lm-studio" }.
// Same stand-in as verify-i18n.cjs serves.
const http = require("node:http");

function standInModel(reply = "Here it is.") {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] })); return; }
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      const body = JSON.parse(raw || "{}");
      const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  const listen = () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(1234, "127.0.0.1", () => resolve(server)); });
  return (async () => { for (let i = 0; ; i++) { try { return await listen(); } catch (error) { if (error.code !== "EADDRINUSE" || i >= 30) throw error; await new Promise((r) => setTimeout(r, 2000)); } } })();
}

/** Serves the stand-in and adds it to the engine through `api`; returns { close } that forgets it and stops serving. */
async function withStandIn(api, reply) {
  const server = await standInModel(reply);
  const id = (await api("connections/from-preset", { provider: "lm-studio", key: "stub-key", model: "stub-model", name: "Stand-in" })).id;
  return { id, close: async () => { await api("connections/forget", { id }).catch(() => {}); server.close(); } };
}

module.exports = { standInModel, withStandIn };
