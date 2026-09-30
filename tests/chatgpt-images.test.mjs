/**
 * The owner pasted a screenshot in the window while GPT-6 Sol on the ChatGPT plan answered, and was told "I couldn't read
 * your screenshot with the current model": the ChatGPT sign-in route said it could not see pictures, so the picture was
 * kept and never sent. It now sends each one as an `input_image` part of the user message, the shape the Codex app uses
 * (codex-rs core/src/client.rs). Local only: the route's fetch is a fake that records each request body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTProvider, createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;

async function window(t) {
  const bodies = [];
  const backend = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const events = [{ type: "response.output_text.delta", delta: "A single dot." }, { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } }];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const provider = new ChatGPTProvider({ accessToken: async () => token }, { model: "gpt-6-sol", fetch: backend });
  const root = await mkdtemp(join(tmpdir(), "branch-chatgpt-images-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}` };
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const upload = async (name, type, body) => {
    const answer = await fetch(`${server.url}/api/attachments/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body, duplex: "half" });
    return (await answer.json()).upload;
  };
  return { bodies, post, upload };
}
/** The picture parts of the last user message the route sent. */
const sentPictures = (bodies) => {
  const users = bodies.flatMap((body) => body.input).filter((item) => item.role === "user");
  return users.at(-1).content.filter((part) => part.type === "input_image");
};

test("a pasted screenshot reaches GPT-6 Sol on the ChatGPT plan as an image part", async (t) => {
  const { bodies, post, upload } = await window(t);
  const sent = await upload("Pasted text.png", "image/png", png);
  const run = await post("/api/run", { prompt: "What does my screenshot show?", uploads: [sent] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const pictures = sentPictures(bodies);
  assert.deepEqual(pictures, [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }]);
  const words = bodies.at(-1).input.filter((item) => item.role === "user").at(-1).content.find((part) => part.type === "input_text").text;
  assert.match(words, /Shown to you with this message: Pasted text\.png/);
  assert.doesNotMatch(words, /cannot look at pictures/);
});

test("a picture sent with the message itself reaches the ChatGPT plan too", async (t) => {
  const { bodies, post } = await window(t);
  const run = await post("/api/run", { prompt: "And this one?", images: [{ mediaType: "image/png", data: png.toString("base64"), name: "shot.png" }] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(sentPictures(bodies).length, 1);
  assert.match(sentPictures(bodies)[0].image_url, /^data:image\/png;base64,iVBOR/);
});
