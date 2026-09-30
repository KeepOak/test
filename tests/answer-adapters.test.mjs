/* RES-334: typed answer adapters (src/answer-adapters.ts): chat, JSON and XML answers are parsed against the declared
   fields, a malformed answer gets exactly one formatting repair, and provider failures are never retried. */
import test from "node:test";
import assert from "node:assert/strict";
import { adaptAnswer } from "../dist/answer-adapters.js";

const signature = { name: "grade", instructions: "Grade the answer.",
  inputs: { answer: { type: "string" } }, outputs: { score: { type: "integer" }, verdict: { type: "string", choices: ["pass", "fail"] } } };
const asking = (...replies) => { const seen = []; return { seen, ask: async (messages, shape) => { seen.push({ messages, shape }); return replies[seen.length - 1]; } }; };

test("JSON, XML and chat answers resolve to the declared typed fields", async () => {
  const json = asking('{"score": 7, "verdict": "pass"}');
  assert.deepEqual(await adaptAnswer({ adapter: "json", signature, inputs: { answer: "42" } }, json.ask),
    { status: "resolved", value: { score: 7, verdict: "pass" }, adapter: "json", reasked: false });
  assert.ok(json.seen[0].shape?.schema, "JSON asks the model for its native structured shape");
  const xml = asking("<score>3</score><verdict>fail</verdict>");
  assert.deepEqual((await adaptAnswer({ adapter: "xml", signature, inputs: { answer: "x" } }, xml.ask)).value, { score: 3, verdict: "fail" });
  const chat = asking("[[ ## score ## ]]\n9\n\n[[ ## verdict ## ]]\npass\n\n[[ ## completed ## ]]");
  assert.deepEqual((await adaptAnswer({ adapter: "chat", signature, inputs: { answer: "x" } }, chat.ask)).value, { score: 9, verdict: "pass" });
});

test("one repair for a malformed answer, then a plain refusal; a provider failure is not retried", async () => {
  const fixed = asking('{"score": "seven", "verdict": "pass"}', '{"score": 7, "verdict": "pass"}');
  const repaired = await adaptAnswer({ adapter: "json", signature, inputs: { answer: "x" } }, fixed.ask);
  assert.equal(repaired.status, "resolved"); assert.equal(repaired.reasked, true);
  assert.match(fixed.seen[1].messages.at(-1).content, /Correct the previous formatting error/);
  const never = asking("not json", "still not json", "unused");
  const refused = await adaptAnswer({ adapter: "json", signature, inputs: { answer: "x" } }, never.ask);
  assert.equal(refused.status, "refused"); assert.equal(never.seen.length, 2, "exactly one repair");
  let calls = 0;
  await assert.rejects(adaptAnswer({ adapter: "json", signature, inputs: { answer: "x" } }, async () => { calls++; throw new Error("service down"); }), /service down/);
  assert.equal(calls, 1);
  await assert.rejects(adaptAnswer({ adapter: "json", signature, inputs: { answer: 5 } }, fixed.ask), "inputs are checked against their declared types");
});
