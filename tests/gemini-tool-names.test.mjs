import test from "node:test";
import assert from "node:assert/strict";
import { geminiMessages } from "../dist/providers/gemini.js";

test("a tool result sent to Gemini names the function of the call it answers, not its own first word", () => {
  const sent = geminiMessages([
    { role: "user", content: "read two files" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: "{\"path\":\"a.txt\"}" }, { id: "c2", name: "files.list", arguments: "{}" }] },
    { role: "tool", toolCallId: "c2", content: "{\"entries\":[]}" },
    { role: "tool", toolCallId: "c1", content: "error: not found" },
  ]);
  const answers = sent.flatMap((message) => message.parts).filter((part) => part.functionResponse).map((part) => part.functionResponse.name);
  const calls = sent.flatMap((message) => message.parts).filter((part) => part.functionCall).map((part) => part.functionCall.name);
  assert.deepEqual(answers, [calls[1], calls[0]], "each answer carries the wire name of its own call");
  assert.ok(!answers.includes("error"));
});
