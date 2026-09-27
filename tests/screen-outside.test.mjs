import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { describesScreen, screenWithheldRefusal } from "../dist/screen-guard.js";
import { mcpToolName, registerCachedMcp } from "../dist/integrations/mcp.js";

const shotName = mcpToolName("cu", "snap");
import { setLockdown } from "../dist/lockdown.js";

/* Dogfood follow-up: a computer-use or screen tool the owner installed from outside (an MCP server, a program lending
   tools) is a screen tool whatever it is called, so it gets the same guard as desktop.*: not offered to research,
   refused without asking there, asked about first when the owner starts a screen task, refused under Lockdown.
   Every such tool here is a stand-in that only counts its calls. */

test("what a tool says about itself decides: category, name, description, inputs; a browser of its own is not the screen", () => {
  const yes = [
    { name: "screenshot", description: "Take a screenshot of the user's desktop." },
    { name: "left_click", description: "Left-click at a point on the screen." },
    { name: "type", description: "Type text with the keyboard into whatever has focus on the screen." },
    { name: "click_text", description: "Find text in any native app window and click it." },
    { name: "computer", description: "Use the computer.", inputSchema: { properties: { action: { enum: ["screenshot", "left_click", "key"] } } } },
    { name: "act", description: "Does things.", inputSchema: { properties: { action: { enum: ["mouse_move", "double_click"] } } } },
    { name: "run", description: "Runs a step.", category: "computer-use" },
    { name: "readClipboard", description: "Returns text." },
    // A browser word in the name never exempts inputs that are computer-use actions.
    { name: "browser_computer", description: "Controls the page.", inputSchema: { properties: { action: { enum: ["left_click", "screenshot"] } } } },
    { name: "tab_helper", title: "Web page tools", description: "Helps.", inputSchema: { properties: { action: { enum: ["mouse_move"] } } } },
  ];
  for (const tool of yes) assert.equal(describesScreen(tool), true, tool.name);
  const no = [
    { name: "browser_click", description: "Click an element on the page." },
    { name: "browser_take_screenshot", description: "Take a screenshot of the current page.",
      inputSchema: { type: "object", properties: { type: { type: "string", enum: ["png", "jpeg"] }, filename: { type: "string" }, fullPage: { type: "boolean" } } } },
    { name: "get_user_by_screen_name", description: "Look up a social account by its screen name." },
    { name: "search_issues", description: "Search the issues of a repository." },
    { name: "navigate", description: "Open a URL in the browser tab." },
    { name: "echo", description: "Say something back." },
  ];
  for (const tool of no) assert.equal(describesScreen(tool), false, tool.name);
});

async function scripted(t, replies) {
  const root = await mkdtemp(join(tmpdir(), "branch-screen-outside-"));
  await mkdir(join(root, "w"), { recursive: true });
  const seen = [];
  const provider = { name: "scripted", async complete(request) {
    seen.push(request);
    const next = replies[Math.min(seen.length, replies.length) - 1];
    return typeof next === "function" ? next(request) : next;
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const calls = [];
  // A program lending a computer-use tool, named outside desktop.*.
  app.registry.register({ name: "client.helper.left_click", group: "client", external: true, permission: "client.tools",
    description: "Left-click at a point on the screen (lent by helper)", parameters: z.record(z.string(), z.unknown()),
    execute: async (input) => { calls.push({ name: "left_click", input }); return { ok: true }; } });
  // An MCP server's screenshot tool, registered the way a remembered server's tools are.
  const [mcpShot] = registerCachedMcp(app.registry, { id: "cu", transport: "stdio", command: process.execPath, args: ["-e", ""], tools: ["snap"], expectedVersion: "1.0.0" },
    [{ name: "snap", description: "Capture the whole desktop as a picture.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    async () => ({ call: async () => { calls.push({ name: "snap" }); return { content: [{ type: "text", text: "ok" }] }; } }));
  // An ordinary MCP tool from the same kind of server, which must stay offered.
  const [mcpEcho] = registerCachedMcp(app.registry, { id: "plain", transport: "stdio", command: process.execPath, args: ["-e", ""], tools: ["echo"], expectedVersion: "1.0.0" },
    [{ name: "echo", description: "Say something back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    async () => ({ call: async () => ({ content: [{ type: "text", text: "ok" }] }) }));
  return { app, seen, calls, mcpShot, mcpEcho };
}
const call = (name, args, id = "c1") => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const done = { content: "Done.", toolCalls: [] };
const events = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind);

test("the registry knows an outside screen tool, by its declaration or by what it says, and not an ordinary one", async (t) => {
  const { app, mcpShot, mcpEcho } = await scripted(t, [done]);
  assert.equal(app.registry.declaresScreen("client.helper.left_click"), true);
  assert.equal(app.registry.declaresScreen(mcpShot), true, "the MCP definition marks its screen tool");
  assert.equal(app.registry.declaresScreen(mcpEcho), false);
  assert.equal(app.registry.declaresScreen("files.read"), false, "the product's own tools are not read by the classifier");
  // A tool that says so only by its declaration: a plain description, but it declares itself a screen tool.
  app.registry.register({ name: "plugin.cu.step", external: true, source: "plugin:cu", permission: "plugin.cu.step", screen: true,
    description: "Does the next step.", parameters: z.record(z.string(), z.unknown()), execute: async () => ({ ok: true }) });
  assert.equal(app.registry.declaresScreen("plugin.cu.step"), true, "a declared screen tool counts whatever its words say");
  // A server's tool whose screen-ness is in its own name only; Branch lists it under a hashed name with a plain description.
  const [named] = registerCachedMcp(app.registry, { id: "cu2", transport: "stdio", command: process.execPath, args: ["-e", ""], tools: ["take_screenshot"], expectedVersion: "1.0.0" },
    [{ name: "take_screenshot", description: "Gets a picture.", inputSchema: { type: "object", properties: {} } }],
    async () => ({ call: async () => ({ content: [] }) }));
  assert.equal(app.registry.declaresScreen(named), true, "the MCP definition read the server's own name for it");
  // One that says so only in its annotations' title.
  const [titled] = registerCachedMcp(app.registry, { id: "cu3", transport: "stdio", command: process.execPath, args: ["-e", ""], tools: ["step"], expectedVersion: "1.0.0" },
    [{ name: "step", description: "Gets a picture.", annotations: { title: "Desktop screenshot" }, inputSchema: { type: "object", properties: {} } }],
    async () => ({ call: async () => ({ content: [] }) }));
  assert.equal(app.registry.declaresScreen(titled), true, "the MCP definition read the server's annotations title");
});

test("research is not offered outside screen tools, and a call to one is refused without asking or running", async (t) => {
  const { app, seen, calls, mcpShot, mcpEcho } = await scripted(t, [call("client.helper.left_click", { x: 5, y: 5 }, "k1"), call(shotName, {}, "s1"), done]);
  assert.equal(mcpShot, shotName);
  const run = await app.runtime.run({ prompt: "Read-only web research: what changed in Node 26?", conversationMode: "full" });
  assert.equal(run.status, "completed");
  for (const request of seen) {
    const names = request.tools.map((tool) => tool.name);
    assert.ok(!names.includes("client.helper.left_click") && !names.includes(mcpShot), "no outside screen tool travels");
  }
  assert.equal(calls.length, 0, "no stand-in ran");
  assert.deepEqual(events(app, run, "policy.denied").filter((event) => event.data.screen === "withheld").map((event) => event.data.name), ["client.helper.left_click", mcpShot]);
  assert.equal(events(app, run, "policy.ask").length, 0);
  assert.ok(app.store.messages(run.sessionId).some((m) => m.role === "tool" && m.content.includes(screenWithheldRefusal.slice(0, 40))));
  void mcpEcho;
});

test("the owner starting a screen task is offered them, is asked first under Full access, and Lockdown refuses them", async (t) => {
  const { app, seen, calls, mcpShot } = await scripted(t, [call(shotName, {}, "s1"), done]);
  const run = await app.runtime.run({ prompt: "take a screenshot of my screen", conversationMode: "full" });
  assert.equal(events(app, run, "policy.denied").filter((event) => event.data.screen === "withheld").length, 0, "asked for in the owner's words, it is not withheld");
  void seen;
  assert.equal(run.status, "needs_input", "the first screen use asks, even under Full access");
  assert.equal(calls.length, 0);
  const [waiting] = app.runtime.approvals.waiting(run.sessionId);
  assert.equal(waiting.tool, mcpShot);
  assert.equal(waiting.noAlways, true, "no Yes, always");
  setLockdown(app.store, app.runtime.owner, { on: true });
  const context = app.runtime.context({ runId: run.id });
  const locked = app.runtime.checkPolicy(mcpShot, {}, context);
  assert.equal(locked.decision, "deny");
  assert.match(locked.reason, /Lockdown is on/);
});
