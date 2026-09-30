// A scripted "model" for the offline run of the SELF-314 night gate (scripts/selfdev-night.mjs): an OpenAI-compatible
// /chat/completions endpoint on 127.0.0.1 that takes the night's queue one tool call at a time. It lives in the gate's
// own process, so it keeps its place when the engine is killed and started again, as a real model's conversation
// would. It is not a model: it proves the gate, the engine and the recovery, never judgement.
import { createServer } from "node:http";

const call = (name, args) => ({ name, args });

/** The night, in order: the plan sync, the CI fix on the red pull request, then a look at the rest of the queue. */
export function nightSteps(world) {
  const { repo, coordOrigin, appOrigin, redBranch, fixedTest, testFile } = world;
  const steps = [
    call("git.clone", { url: coordOrigin, folder: "coord" }),
    call("shell.execute", { executable: "git", args: ["checkout", "-b", world.coordBranch], cwd: "coord" }),
    call("shell.execute", { executable: "python", args: ["build.py"], cwd: "coord/master" }),
    call("git.commit", { folder: "coord", message: "docs: nightly master-plan sync" }),
    call("git.push", { folder: "coord", remote: "origin", branch: world.coordBranch }),
    call("github.wait_for_checks", { repo, number: world.redPull, seconds: 60 }),
    call("github.check_logs", { repo, number: world.redPull, lines: 80 }),
    call("git.clone", { url: appOrigin, folder: "app", branch: redBranch }),
    call("files.read", { path: `app/${testFile}` }),
    call("files.write", { path: `app/${testFile}`, content: fixedTest }),
    call("shell.execute", { executable: "node", args: ["--test", testFile], cwd: "app" }),
    call("git.commit", { folder: "app", message: "fix: the theme test expects the shipped default" }),
    call("git.push", { folder: "app", remote: "origin", branch: redBranch }),
    call("github.wait_for_checks", { repo, number: world.redPull, seconds: 120 }),
    call("github.merge_pull_request", { repo, number: world.redPull }),
    call("github.wait_for_checks", { repo, number: world.otherPull, seconds: 60 }),
  ];
  // As a model does: the tools it needs are loaded by name first (tools.describe), then used.
  const names = [...new Set(steps.map((step) => step.name))].filter((name) => !name.startsWith("files."));
  return [call("tools.describe", { names }), ...steps];
}

/** One chunked answer in OpenAI's streaming shape: a tool call, or plain words. */
function chunks(step, id) {
  const choice = (delta, finish = null) => ({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
  const usage = { id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
  if (typeof step === "string") return [choice({ role: "assistant", content: step }), choice({}, "stop"), usage];
  const tool = { index: 0, id: `call_${id}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } };
  return [choice({ role: "assistant", tool_calls: [tool] }), choice({}, "tool_calls"), usage];
}

/** Starts the endpoint. Requests without tools (titles, summaries, a Trunk's hello) get a short plain answer. */
export async function startNightBrain(world) {
  const steps = nightSteps(world);
  const state = { at: 0, requests: 0, answered: [], retries: 0 };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text || "{}");
      state.requests++;
      const working = Array.isArray(body.tools) && body.tools.length > 0;
      // A step the engine said was not offered (yet) is asked for again, a few times at most.
      const lastSaid = String(body.messages?.at(-1)?.content ?? "");
      if (working && state.at > 0 && /is not one of the tools offered/.test(lastSaid) && state.retries++ < 3) state.at--;
      const step = !working ? "OK." : state.at < steps.length ? steps[state.at++]
        : `Night done. Plan synced to ${world.coordBranch}; pull request #${world.redPull} fixed and merged on green; #${world.otherPull} is red and was left open.`;
      state.answered.push(typeof step === "string" ? step.slice(0, 40) : step.name);
      const id = `night${state.requests}`;
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of chunks(step, id)) response.write(`data: ${JSON.stringify(part)}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      const message = typeof step === "string" ? { role: "assistant", content: step }
        : { role: "assistant", content: null, tool_calls: [{ id: `call_${id}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id, object: "chat.completion", choices: [{ index: 0, message, finish_reason: typeof step === "string" ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, state, total: steps.length,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
