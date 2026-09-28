/* A model service on this computer, OpenAI-shaped, that answers from a script the test controls: each request takes the
   next step, and a step can be held until the test lets it go, so a test waits on real conditions, never on a clock. */
import { createServer } from "node:http";

/** steps: [{ tool: "memory.search", args: {...} } | { text: "..." }], each optionally { held: true }. */
export async function scriptedModel(t, steps) {
  const asked = [];
  const releases = new Map();
  const heard = [];
  let next = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      if (request.url.endsWith("/models")) { response.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
      let body = {};
      try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const index = next++;
      asked.push({ index, body });
      for (const wake of heard.splice(0)) wake();
      const step = steps[index] ?? { text: "Done." };
      if (step.held) await new Promise((release) => releases.set(index, release));
      const message = step.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call${index}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }
        : { role: "assistant", content: step.text };
      if (body.stream) {
        const frame = (delta, finish) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        const delta = step.tool ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: "assistant", content: step.text };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame(delta, null) + frame({}, step.tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: step.tool ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { for (const release of releases.values()) release(); server.closeAllConnections(); server.close(() => done()); }));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    asked,
    /** Resolves once at least `count` questions reached the model. */
    async until(count) { while (asked.length < count) await new Promise((wake) => heard.push(wake)); },
    release(index) { const release = releases.get(index); if (!release) throw new Error(`step ${index} is not held`); releases.delete(index); release(); },
  };
}
