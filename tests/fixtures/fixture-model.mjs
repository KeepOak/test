/* The tests' scripted model, as an OpenAI-shaped service on this computer. Branch has no demo model of its own: a test
   that starts `branch` (or the desktop app) in another process points it here with ordinary settings
   (BRANCH_PROVIDER=openai and this address). Nothing in the product can reach it.

   It answers from the request alone, never from a count of earlier requests, so any number of tasks and processes can
   share it: after the newest user message it writes branch-demo.txt, reads it back, verifies it, then says so. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const path = "branch-demo.txt", content = "Hello from Branch.\n";
const steps = [["files.write", { path, content }], ["files.read", { path }], ["files.verify", { path, expected: content }]];
const digest = (name) => createHash("sha256").update(name).digest("hex").slice(0, 24);

/** The name a tool travels under in this request (its own name, or the hash a hosted connection sends), or null. */
function wire(name, tools) {
  const offered = new Set((tools ?? []).map((tool) => tool?.function?.name ?? tool?.name));
  const hashed = "branch_" + digest(name);
  return offered.has(name) ? name : offered.has(hashed) ? hashed : null;
}

/**
 * The next turn, worked out from the messages only (the script the in-process fixture follows). The step reached is
 * read from the answers to this script's own calls (`demo-0` to `demo-2`), so a note Branch adds between rounds does
 * not start it again; a finished answer (no call) ends one run of the script, and the next request starts it afresh.
 * A step whose tool this request does not offer (Branch narrows the tools it offers to the task) is left out.
 */
export function fixtureTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let done = 0, last = "";
  for (const message of messages) {
    if (message?.role === "assistant" && !message.tool_calls?.length) { done = 0; last = ""; }
    const reached = message?.role === "tool" ? /^demo-(\d)$/.exec(String(message.tool_call_id ?? "")) : null;
    if (reached) { done = Number(reached[1]) + 1; last = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""); }
  }
  for (let at = done; at < steps.length; at++) {
    const [tool, input] = steps[at], name = wire(tool, body.tools);
    if (name) return { text: `Deterministic demo fixture: step ${at + 1} of ${steps.length}, ${tool}.`,
      call: { id: `demo-${at}`, name, arguments: JSON.stringify(input) } };
  }
  if (last.includes('"verified":true')) return { text: "Demo fixture completed: wrote, read, and verified branch-demo.txt." };
  return { text: done ? "Demo fixture completed the steps it was offered tools for." : "Demo fixture could not verify the file; inspect tool errors." };
}

function answer(body, response) {
  const turn = fixtureTurn(body);
  const toolCalls = turn.call ? [{ id: turn.call.id, type: "function", function: { name: turn.call.name, arguments: turn.call.arguments } }] : undefined;
  const finish = turn.call ? "tool_calls" : "stop";
  if (body.stream) {
    const frame = (delta, reason, usage) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
      choices: reason === undefined ? [] : [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`;
    const delta = { role: "assistant", content: turn.text, ...(toolCalls ? { tool_calls: [{ index: 0, ...toolCalls[0] }] } : {}) };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame(delta, null) + frame({}, finish) + frame({}, undefined, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) + "data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "fixture", object: "chat.completion", created: 0, model: "fixture",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: turn.text, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}

let started = null;
/**
 * The address of this process's fixture model, started on first use. It never keeps the test process alive, and it
 * closes with it. The settings name it the way an owner names any OpenAI-compatible service.
 */
export function fixtureModel() {
  started ??= new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        if (request.url.endsWith("/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
        if (!request.url.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
        let body = {};
        try { body = JSON.parse(raw); } catch { /* answered as an empty request */ }
        answer(body, response);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.unref(); resolve(`http://127.0.0.1:${server.address().port}/v1`); });
  });
  return started.then((endpoint) => ({ endpoint,
    env: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: endpoint, BRANCH_MODEL: "fixture", BRANCH_API_KEY: "fixture-key" } }));
}
