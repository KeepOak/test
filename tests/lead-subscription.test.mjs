/**
 * SELF-301: the lead runs on the owner's Claude subscription, Opus 5.5 by default, with Branch's full tools and an
 * effort setting. The lead is the default Trunk in Full Access; the subscription is the unmodified `claude` program
 * (native protocol fixture, no network). What is checked is what reaches the program: the model and effort flags on
 * its command line, and Branch's own tools offered and run through Branch's tool loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { discardTemp } from "./temp-dir.mjs";

const pool = "cli-claude-code";
function stream(block) {
  const events = [{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("the default Trunk runs on the Claude subscription at Opus 5.5, with Branch's tools and the owner's effort", async (t) => {
  const parent = join(tmpdir(), "claude-session-files"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "lead-subscription-")), saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "primary-native-account");
  let app;
  try { app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") }); }
  finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  service.noteSignIn(pool, "primary", { installed: true, signedIn: true, identity: { email: "owner@fixture.invalid", authMethod: "claude.ai" }, message: "Signed in" });
  const launches = [], offered = [];
  service.deps.claudeSubscription = {
    spawn: (_command, args, invocation) => {
      launches.push(args);
      return spawn(process.execPath, [resolve("tests/fixtures/claude-subscription-native.mjs"), ...args], invocation);
    },
    connect: async (_headers, payload) => {
      const body = JSON.parse(payload);
      offered.push(body.tools.map((tool) => tool.description.match(/^Branch tool ([a-z0-9_.-]+)\./)?.[1]).filter(Boolean));
      const results = body.messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result");
      const done = results[0];
      const asked = body.messages.flatMap((message) => message.content).map((part) => part.text ?? "").join(" ");
      const named = (name) => body.tools.find((tool) => tool.description.startsWith(`Branch tool ${name}.`));
      if (/What is scheduled/.test(asked)) {
        const at = body.messages.findLastIndex((message) => message.content.some((part) => /What is scheduled/.test(part.text ?? "")));
        const since = body.messages.slice(at).flatMap((message) => message.content).filter((part) => part.type === "tool_result").length;
        if (since === 0) return stream({ type: "tool_use", id: "open-box", name: named("tools.expand").name, input: { groups: ["schedules"] } });
        if (since === 1 && named("schedules.list")) return stream({ type: "tool_use", id: "list", name: named("schedules.list").name, input: {} });
        return stream({ type: "text", text: "Nothing is scheduled." });
      }
      const read = named("files.read");
      if (!done && read) return stream({ type: "tool_use", id: "read-plan", name: read.name, input: { path: "plan.md" } });
      return stream({ type: "text", text: done ? `Read: ${done.content}` : "ok" });
    },
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" });
  app.runtime.models.configure(app.runtime.owner, { activePreset: pool });
  await writeFile(join(root, "workspace", "plan.md"), "SELF-301 proof");
  const home = app.trunks.ensureDefault(true);

  const first = await app.runtime.run({ prompt: "Read plan.md and tell me what it says", trunkId: home.id, mode: "full" });
  assert.equal(first.status, "completed", first.output);
  assert.match(first.output, /SELF-301 proof/, "Branch's own tool ran through the subscription");
  assert.equal(app.store.events(first.id).filter((e) => e.kind === "tool.completed" && e.data.name === "files.read").length, 1);
  assert.equal(app.store.events(first.id).filter((e) => /approval|needs_input/.test(e.kind)).length, 0, "no question in Full Access");
  const flag = (args, name) => args[args.indexOf(name) + 1];
  assert.ok(launches.length >= 2);
  for (const args of launches) {
    assert.equal(flag(args, "--model"), "claude-opus-5-5", "Opus 5.5 by default");
    assert.equal(flag(args, "--effort"), "medium", "medium effort by default");
  }
  // Every other tool of Branch's is one step away: the catalog opens its box (tools.expand) when the work calls for it.
  assert.ok(["files.read", "files.write", "files.edit", "tools.search", "tools.expand"].every((name) => offered[0].includes(name)), JSON.stringify(offered[0]));
  assert.ok(offered[0].includes("files.read") && offered[0].includes("files.write"));

  // The owner turns the effort up for this conversation; the next turn carries it to the program.
  app.runtime.models.configureSession(app.runtime.owner, first.sessionId, { reasoning: "high" });
  const before = launches.length;
  const second = await app.runtime.run({ prompt: "Read plan.md again", sessionId: first.sessionId, trunkId: home.id });
  assert.equal(second.status, "completed", second.output);
  assert.ok(launches.length > before);
  for (const args of launches.slice(before)) assert.equal(flag(args, "--effort"), "high", "the owner's effort reaches the program");

  // A tool outside the first set: the lead opens its box and runs it, all through the subscription.
  const third = await app.runtime.run({ prompt: "What is scheduled?", sessionId: first.sessionId, trunkId: home.id });
  assert.equal(third.status, "completed", third.output);
  assert.ok(app.store.events(third.id).some((e) => e.kind === "catalog.expanded"), "the schedules box was opened");
  assert.ok(app.store.events(third.id).some((e) => e.kind === "tool.completed" && e.data.name === "schedules.list"), "and its tool ran");
});
