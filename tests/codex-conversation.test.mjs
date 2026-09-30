/* SELF-090: a Codex conversation keeps its thread on the warm app-server. When the next request is exactly the last one
   plus Codex's own answer and new messages, the same thread is continued and only the new messages are sent; changed
   history, changed tools, no conversation, or a second call at the same moment start a fresh thread with the whole
   transcript. Words from another turn are never taken as this turn's. Stand-in app-server children only. */
import test from "node:test";
import assert from "node:assert/strict";
import { CliAgentProvider, cliAgentCatalog } from "../dist/providers/cli-agent.js";
import { closeWarmCodex } from "../dist/asks/codex-app-server.js";
import { withAccountCall } from "../dist/accounts/context.js";

test.afterEach(() => closeWarmCodex());

const codexRow = () => cliAgentCatalog.find((row) => row.id === "codex");

/** A stand-in app-server: each turn answers "answer N" on its thread, tagged with its own turn id. */
function appServer({ foreign = false } = {}) {
  const turns = [], listeners = [];
  let threads = 0;
  const reply = (message) => setImmediate(() => { for (const fn of listeners) fn(message); });
  const child = {
    send(message) {
      if (message.method === "initialize") reply({ id: message.id, result: { userAgent: "codex/1" } });
      if (message.method === "thread/start") reply({ id: message.id, result: { thread: { id: `thr${++threads}` } } });
      if (message.method === "turn/start") {
        const threadId = message.params.threadId, turnId = `turn${turns.length + 1}`;
        turns.push({ threadId, text: message.params.input[0].text });
        reply({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        if (foreign) reply({ method: "item/agentMessage/delta", params: { threadId, turnId: "someone-else", delta: "LEAKED " } });
        reply({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: `answer ${turns.length}` } });
        reply({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }
    },
    onMessage: (fn) => listeners.push(fn), onExit: () => {}, stop() {},
  };
  const provider = new CliAgentProvider(codexRow(), {}, async () => assert.fail("exec is not used when app-server answers"));
  provider.appServer = () => { listeners.length = 0; return child; };
  return { turns, provider };
}

const user = (content) => ({ role: "user", content }), assistant = (content) => ({ role: "assistant", content });
const ask = (provider, messages, { session = "s1", tools } = {}) => {
  const request = { messages, signal: AbortSignal.timeout(10000), ...(tools ? { tools } : {}) };
  return session ? withAccountCall({ owner: "owner", sessionId: session, runId: "r1" }, () => provider.complete(request))
    : provider.complete(request);
};

test("SELF-090 exact growth of the same conversation continues its Codex thread and sends only the new message", async () => {
  const { turns, provider } = appServer();
  assert.equal((await ask(provider, [user("first question")])).content, "answer 1");
  assert.equal((await ask(provider, [user("first question"), assistant("answer 1"), user("second question")])).content, "answer 2");
  assert.equal(turns[1].threadId, turns[0].threadId, "the same thread is continued");
  assert.match(turns[1].text, /second question/);
  assert.doesNotMatch(turns[1].text, /first question/, "what the thread already holds is not sent again");
  const third = [user("first question"), assistant("answer 1"), user("second question"), assistant("answer 2"), user("third")];
  await ask(provider, third);
  assert.equal(turns[2].threadId, turns[0].threadId);
});

test("SELF-090 changed history, changed tools or no conversation start a fresh thread with the whole transcript", async () => {
  const { turns, provider } = appServer();
  await ask(provider, [user("first question")]);
  await ask(provider, [user("first question"), assistant("an answer Codex never gave"), user("second question")]);
  assert.notEqual(turns[1].threadId, turns[0].threadId, "edited history is not continued");
  assert.match(turns[1].text, /first question[\s\S]*second question/);
  await ask(provider, [user("first question"), assistant("an answer Codex never gave"), user("second question"), assistant("answer 2"), user("third")],
    { tools: [{ name: "files.read", description: "read", parameters: { type: "object", properties: {} } }] });
  assert.notEqual(turns[2].threadId, turns[1].threadId, "new tools are a new context");
  await ask(provider, [user("alone")], { session: null });
  await ask(provider, [user("alone"), assistant("answer 4"), user("again")], { session: null });
  assert.notEqual(turns[4].threadId, turns[3].threadId, "a call outside a conversation is never continued");
  assert.match(turns[4].text, /alone[\s\S]*again/);
});

test("SELF-090 a second call at the same moment never borrows the thread that is still answering", async () => {
  const { turns, provider } = appServer();
  await ask(provider, [user("first question")]);
  const next = [user("first question"), assistant("answer 1"), user("second question")];
  await Promise.all([ask(provider, next), ask(provider, next)]);
  assert.equal(turns.length, 3);
  assert.notEqual(turns[1].threadId, turns[2].threadId, "the two calls answer on different threads");
  assert.equal([turns[1], turns[2]].filter((turn) => turn.threadId === turns[0].threadId).length, 1, "only one continues");
  assert.equal([turns[1], turns[2]].filter((turn) => /first question/.test(turn.text)).length, 1, "the other sends the whole transcript");
});

test("SELF-090 words tagged with another turn are not taken as this turn's answer", async () => {
  const { provider } = appServer({ foreign: true });
  assert.equal((await ask(provider, [user("hello")])).content, "answer 1");
});
