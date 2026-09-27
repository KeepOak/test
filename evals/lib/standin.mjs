/**
 * The stand-in model for the CI smoke subset: an OpenAI-shaped chat service on this computer that answers from a
 * script instead of thinking. It proves the harness and the engine's plumbing (tool calls, approvals, memory), never a
 * model's quality, and every scorecard it produces says "stand-in" on it. `script(request)` returns
 * `{ text }` or `{ tool, args }`; the engine's real tool names are matched by the script, not assumed.
 */
import http from "node:http";

export async function startStandin(port, initialScript = () => ({ text: "" })) {
  const seen = [];
  const box = { script: initialScript, seen, close: null, port };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) return json(res, { object: "list", data: [{ id: "stand-in", object: "model" }] });
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
      const input = JSON.parse(body || "{}");
      seen.push(input);
      let reply;
      try { reply = box.script(input) ?? { text: "I have nothing scripted for that." }; } catch (error) { reply = { text: `stand-in script failed: ${error.message}` }; }
      answer(res, input, reply);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  box.port = server.address().port;
  box.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return box;
}

function json(res, value) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }

function answer(res, input, reply) {
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(input.messages ?? []).length / 4), completion_tokens: 12, total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const call = reply.tool ? [{ id: `call_${Date.now().toString(36)}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] : null;
  const message = call ? { role: "assistant", content: null, tool_calls: call } : { role: "assistant", content: reply.text };
  const finish = call ? "tool_calls" : "stop";
  if (!input.stream) return json(res, { id: "standin", object: "chat.completion", model: input.model, choices: [{ index: 0, message, finish_reason: finish }], usage });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, reason = null, extra = {}) => `data: ${JSON.stringify({ id: "standin", object: "chat.completion.chunk", model: input.model, choices: [{ index: 0, delta, finish_reason: reason }], ...extra })}\n\n`;
  if (call) res.write(chunk({ role: "assistant", tool_calls: call.map((c, index) => ({ index, ...c })) }));
  else res.write(chunk({ role: "assistant", content: reply.text }));
  res.write(chunk({}, finish, { usage }));
  res.end("data: [DONE]\n\n");
}

/** Helpers a script uses to read what the engine sent. */
export const lastUser = (input) => text([...(input.messages ?? [])].reverse().find((m) => m.role === "user"));
export const text = (message) => (typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? ""));
export const afterTool = (input) => input.messages?.at(-1)?.role === "tool";
/** The engine sends the real tool names hashed, so a script finds a tool by its description, not its name. */
export const toolNamed = (input, pattern) => (input.tools ?? []).find((t) => pattern.test(t.function?.description ?? ""))?.function?.name;
export const systemText = (input) => (input.messages ?? []).filter((m) => m.role === "system").map(text).join("\n");
