/** selfdev (SELF-314): a task carried on after a restart is offered again the tools its conversation was using. */
import test from "node:test";
import assert from "node:assert/strict";
import { carriedOnTools } from "../dist/runtime.js";

const store = (resumedFrom) => ({ events: () => [{ kind: "run.started", data: resumedFrom ? { resumedFrom } : {} }] });
const call = (name, args = {}) => ({ role: "assistant", content: "", toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }] });
const tools = ["git.push", "github.wait_for_checks", "github.merge_pull_request", "shell.execute", "email.send"].map((name) => ({ name }));

test("a carried-on task starts with the tools it called or named, newest last, and only ones it is offered", () => {
  const messages = [call("tools.describe", { names: ["github.merge_pull_request", "github.wait_for_checks", "not.a.tool"] }),
    call("shell.execute"), call("git.push"), call("github.wait_for_checks")];
  const carried = carriedOnTools(store("earlier-run"), "run", messages, tools, ["email.send"]).map((entry) => entry.name);
  assert.deepEqual(carried, ["tools.describe", "github.merge_pull_request", "shell.execute", "git.push", "github.wait_for_checks"]
    .filter((name) => tools.some((tool) => tool.name === name)));
  assert.ok(!carried.includes("not.a.tool") && !carried.includes("email.send"), "never one it is not offered, nor one switched off");
});

test("a task that was not carried on starts as before", () => {
  assert.deepEqual(carriedOnTools(store(null), "run", [call("git.push")], tools, []), []);
});
