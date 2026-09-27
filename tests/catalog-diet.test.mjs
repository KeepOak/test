import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import {
  createBranch, ToolCatalog, anthropicBody, openaiBody, compactionThresholdFloor,
  derivedCompactionThreshold, contextBudget, rankGroups, slimSchema, inferToolGroup,
  expandToolName, estimateTokens, answerReserve, compactionThreshold,
} from "../dist/index.js";

// Mirrors the runtime's own cap, raised to 20000 in wave 5 when the catalog was still whole.
const contextLimit = 20000;
/** A provider driven by a script; each entry is a function of the request. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({ tools: request.tools.map((t) => t.name), messages: request.messages.map((m) => ({ ...m })) });
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)];
    return typeof step === "function" ? step(request) : step;
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: "c" + Math.random().toString(36).slice(2, 8), name, arguments: JSON.stringify(args) }] });
async function fixture(t, steps, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-catalog-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
const eventsOf = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);

test("tools live in groups; closed groups cost one line and the catalog per round is far smaller", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  const everything = app.registry.descriptions(new Set(app.registry.permissions()));
  const fat = app.registry.descriptions(new Set(app.registry.permissions()), { diet: false });
  const collapsed = new ToolCatalog(everything, { expanded: [], groupOf: (n) => app.registry.groupOf(n) });
  const stats = collapsed.stats();
  assert.equal(stats.tools, everything.length);
  const core = everything.filter((tool) => app.registry.groupOf(tool.name) === "core").length;
  assert.equal(stats.shown, core + 1, "only the always-open tools and the opener are described");
  assert.ok(stats.collapsed >= 6, `${stats.collapsed} groups closed`);
  const smaller = (JSON.stringify(fat).length - stats.characters) / JSON.stringify(fat).length;
  assert.ok(smaller >= 0.35, `catalog with every group closed is ${(smaller * 100).toFixed(1)}% smaller`);

  const run = await app.runtime.run({ prompt: "commit my work and push it" });
  assert.equal(run.status, "completed");
  const sent = provider.requests[0].tools;
  assert.ok(sent.includes(expandToolName), "the opener is offered while something is closed");
  assert.ok(sent.length < everything.length / 2, `${sent.length} of ${everything.length} tools were described`);
  const [preselected] = eventsOf(app, run.id, "catalog.preselected");
  assert.ok(preselected.guessed.includes("git"), `guessed ${JSON.stringify(preselected.guessed)}`);
  const [size] = eventsOf(app, run.id, "catalog.size");
  assert.equal(size.round, 1);
  assert.equal(size.tools, everything.length);
  assert.equal(size.shown, sent.length);
  assert.ok(size.estimatedTokens < 2500, `catalog estimated at ${size.estimatedTokens} tokens`);
});

test("a tool in a closed group is found and called through tools.expand, and permissions still decide", async (t) => {
  const { app, provider } = await fixture(t, [
    call(expandToolName, { groups: ["schedules"] }),
    call("schedules.list", {}),
    say("Nothing is scheduled."),
  ]);
  const run = await app.runtime.run({ prompt: "tidy the desk" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Nothing is scheduled.");
  assert.ok(!provider.requests[0].tools.includes("schedules.list"), "the closed tool was not described at first");
  assert.ok(provider.requests[1].tools.includes("schedules.list"),
    "opening the toolbox added its tools. If this broke after you registered a tool, it is the cap in "
    + "src/tool-loading.ts (defaultMaxLoaded), not anything you did: a toolbox holding more tools than "
    + "the cap has to drop some, and ties go by registration order. Do not raise the cap.");
  assert.ok(provider.requests[2].tools.includes("schedules.list"), "it stays open for the rest of the conversation");
  const [expanded] = eventsOf(app, run.id, "catalog.expanded");
  assert.deepEqual(expanded.opened, ["schedules"]);
  assert.ok(expanded.tools >= 2);
  assert.ok(app.store.events(run.id).some((e) => e.kind === "tool.completed" && e.data.name === "schedules.list"));

  // Opening several boxes at once must not park a copy of their schemas in the conversation.
  const wide = new ToolCatalog(app.registry.descriptions(new Set(app.registry.permissions())), { groupOf: (n) => app.registry.groupOf(n) });
  const result = wide.expand(["files", "memory", "agents"]);
  assert.ok(result.tools.length >= 30, `${result.tools.length} tools were opened at once`);
  assert.deepEqual(Object.keys(result.tools[0]).sort(), ["description", "name"], "names and purposes only");
  // Comfortably inside the 12,000-character tool-result limit, so it is never clipped mid-JSON.
  // The owner's rule (ships on, 2026-09-26): ways of working, the fleet, the market, handing on and choosing a project
  // now ship listed in these three boxes (about 8,800 characters opened together), so the margin is 10,000, still
  // 2,000 inside the limit; other computers and project boards moved to their own boxes to keep it there.
  assert.ok(JSON.stringify(result).length < 10_000, `the answer is ${JSON.stringify(result).length} characters`);
  // The size must be bounded by the number of tools, not by how carefully each description was
  // worded. This crept to within 27 characters of the limit once, which meant the next tool anybody
  // registered would have broken this test for a reason that had nothing to do with their work.
  for (const tool of result.tools)
    assert.ok(tool.description.length <= 90,
      `"${tool.name}" lists ${tool.description.length} characters; the listing caps each one at 90`);
  const perTool = JSON.stringify(result).length / result.tools.length;
  assert.ok(perTool < 130, `${perTool.toFixed(0)} characters per tool leaves too little room to add one`);

  const { app: narrow, provider: narrowProvider } = await fixture(t, [
    call(expandToolName, { groups: ["schedules", "nonsense"] }),
    say("I cannot do that here."),
  ]);
  const limited = await narrow.runtime.run({ prompt: "tidy the desk", permissions: ["files.read"] });
  assert.equal(limited.status, "completed");
  const [refused] = eventsOf(narrow, limited.id, "catalog.expanded");
  assert.deepEqual(refused.opened, [], "a toolbox this task may not use cannot be opened");
  assert.deepEqual(refused.unknown.sort(), ["nonsense", "schedules"]);
  assert.ok(!narrowProvider.requests.at(-1).tools.some((name) => name.startsWith("schedules.")));
});

test("the likely toolboxes are guessed from the words of the request", () => {
  const available = ["core", "files", "git", "web", "browser", "desktop", "memory", "documents",
    "schedules", "media", "channels", "agents", "data", "skills", "settings"];
  const table = [
    ["commit the change and push the branch", "git"],
    ["rename every file in that folder", "files"],
    ["look up the price of a used laptop online", "web"],
    ["what did we decide about the kitchen yesterday", "memory"],
    ["find the lease in my documents", "documents"],
    ["remind me tomorrow to call the dentist", "schedules"],
    ["transcribe this audio recording", "media"],
    ["send Sam a message on telegram", "channels"],
    ["delegate the research to a specialist", "agents"],
    ["make a chart from the spreadsheet rows", "data"],
    // Asked of the larger catalog this merged into, one prompt per group a wave has added.
    ["make a picture of a fox", "media"],
    ["what is on my screen", "desktop"],
    ["download the CSV and chart column 3", "data"],
    ["pull the latest model in Ollama", "settings"],
    ["sign me in to Linear", "browser"],
    ["pack this skill and share it", "skills"],
    ["check my Discord messages", "channels"],
    ["watch that page and tell me when it changes", "schedules"],
  ];
  for (const [prompt, expected] of table) {
    const ranked = rankGroups({ prompt }, available, 3);
    assert.ok(ranked.includes(expected), `"${prompt}" ranked ${JSON.stringify(ranked)}, expected ${expected}`);
    assert.ok(ranked.length <= 3 && !ranked.includes("core"));
  }
  assert.deepEqual(rankGroups({ prompt: "hello there" }, available, 3), [], "nothing is opened on a guess with no signal");
  assert.deepEqual(rankGroups({ prompt: "hello", recentTools: ["git.status"] }, available, 1), ["git"], "what the task already used counts");
  assert.ok(rankGroups({ prompt: "hello", project: "photo library" }, available, 2).includes("media"), "the active project counts");
});

test("the schema diet makes the catalog at least a third smaller and still describes a correct call", async (t) => {
  const { app } = await fixture(t, [say("ok")]);
  const permissions = new Set(app.registry.permissions());
  const fat = JSON.stringify(app.registry.descriptions(permissions, { diet: false })).length;
  const slim = JSON.stringify(app.registry.descriptions(permissions)).length;
  const saved = (fat - slim) / fat;
  assert.ok(saved >= 0.35, `catalog went from ${fat} to ${slim} characters (${(saved * 100).toFixed(1)}% smaller)`);

  const before = JSON.stringify(app.registry.descriptions(permissions, { diet: false }));
  const after = JSON.stringify(app.registry.descriptions(permissions));
  assert.ok(before.includes("$schema") && !after.includes("$schema"));
  assert.ok(!after.includes('"additionalProperties":false'));
  assert.ok(!after.includes("maxLength"));
  const memory = app.registry.descriptions(permissions).find((t) => t.name === "memory.put");
  assert.deepEqual(memory.parameters.properties.scope.enum, ["private", "shared"], "enum values are kept");
  assert.deepEqual(memory.parameters.required, ["text", "source"], "the required list is kept");
  assert.equal(memory.parameters.properties.validFrom.format, "date-time", "the shape of a value is still explained");
  assert.ok(!("pattern" in memory.parameters.properties.validFrom), "its generated regular expression is not");
  for (const tool of app.registry.descriptions(permissions)) assert.ok(tool.description.length <= 200, tool.name);

  // The diet only changes what is described: every call is still parsed against the real schema.
  const context = app.runtime.context({ runId: "" });
  await assert.rejects(app.registry.execute("files.read", { path: "a.txt", surprise: 1 }, context), /surprise|Unrecognized/);
});

test("the schema diet keeps property names that happen to look like schema keywords", () => {
  const schema = z.toJSONSchema(z.object({
    pattern: z.string().max(40), required: z.boolean(), maxLength: z.number(), type: z.enum(["a", "b"]),
  }).strict());
  const slim = slimSchema(schema);
  assert.deepEqual(Object.keys(slim.properties).sort(), ["maxLength", "pattern", "required", "type"]);
  assert.deepEqual(slim.properties.type.enum, ["a", "b"]);
  assert.equal(slim.$schema, undefined);
  assert.equal(slim.additionalProperties, undefined);
  const defaulted = slimSchema(z.toJSONSchema(z.object({ q: z.string(), deep: z.boolean().default(false) }).strict()));
  assert.deepEqual(defaulted.required, ["q"], "a value with a default is not demanded of the model");
  assert.equal(inferToolGroup("browser.click"), "browser");
  assert.equal(inferToolGroup("something.odd"), "other");
});

test("a few tools with unfamiliar names stay in view; a pile of them does not", () => {
  const odd = (n) => ({ name: `plugin${n}.do_it`, description: "A tool from somewhere else", parameters: { type: "object" } });
  const few = new ToolCatalog([...Array(5)].map((_, n) => odd(n)));
  assert.equal(few.stats().shown, 5, "nothing in the words of a request could point at these");
  assert.equal(few.stats().collapsed, 0);
  const many = new ToolCatalog([...Array(40)].map((_, n) => odd(n)));
  assert.equal(many.stats().shown, 1, "once there are enough of them they are worth putting away");
  assert.deepEqual(many.expand(["other"]).opened, ["other"]);
  assert.equal(many.stats().shown, 40, "opened again, and with nothing left closed the opener goes away");
});

test("each round reports where the context went, and the compaction threshold is derived from it", async (t) => {
  const { app } = await fixture(t, [say("Done.")]);
  const run = await app.runtime.run({ prompt: "say hello" });
  const [budget] = eventsOf(app, run.id, "context.budget");
  assert.equal(budget.limit, contextLimit);
  assert.equal(budget.reserve, answerReserve);
  assert.ok(budget.catalog > 0 && budget.catalog < 2500, `catalog ${budget.catalog}`);
  assert.ok(budget.system > 0 && budget.system <= budget.messages);
  assert.equal(budget.headroom, budget.limit - budget.catalog - budget.messages);
  assert.equal(budget.threshold, derivedCompactionThreshold(budget.catalog, budget.limit, budget.reserve));
  assert.ok(budget.threshold > compactionThresholdFloor, `threshold ${budget.threshold} is derived, not the floor`);

  assert.equal(compactionThresholdFloor, 11000, "the old constant is still available to anything that references it");
  assert.equal(compactionThreshold, compactionThresholdFloor, "the name older tests import now means the floor");
  assert.equal(derivedCompactionThreshold(200, 16000, 2048), 13752);
  assert.equal(derivedCompactionThreshold(9000, 16000, 2048), compactionThresholdFloor, "a huge catalog cannot squeeze the conversation to nothing");
  const accounting = contextBudget({ limit: 16000, system: 400, catalog: 1000, messages: 3000 });
  assert.equal(accounting.headroom, 12000);
  assert.equal(accounting.reserve, answerReserve);
});

test("the request is ordered and marked so a provider can cache the instructions and the catalog", async (t) => {
  const request = {
    maxTokens: 1024,
    tools: [
      { name: "files.read", description: "Read a file", parameters: { type: "object" } },
      { name: "git.status", description: "Show changes", parameters: { type: "object" } },
    ],
    messages: [
      { role: "system", content: "You are a local assistant." },
      { role: "user", content: "hello" },
    ],
  };
  const body = anthropicBody(request, "claude-test");
  const keys = Object.keys(body);
  assert.ok(keys.indexOf("tools") < keys.indexOf("system"), "tools come before the instructions");
  assert.ok(keys.indexOf("system") < keys.indexOf("messages"), "both come before the conversation");
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(body.tools[0].cache_control, undefined, "one marker ends the catalog, not one per tool");
  assert.deepEqual(body.system, [{ type: "text", text: "You are a local assistant.", cache_control: { type: "ephemeral" } }]);
  const later = anthropicBody({ ...request, messages: [...request.messages, { role: "assistant", content: "hi" }] }, "claude-test");
  assert.equal(JSON.stringify(later.tools), JSON.stringify(body.tools), "the catalog is identical on the next round");
  assert.equal(JSON.stringify(later.system), JSON.stringify(body.system), "so are the instructions");
  const openai = Object.keys(openaiBody(request, "gpt-test"));
  assert.ok(openai.indexOf("tools") < openai.indexOf("messages"), "the stable prefix goes first for prefix caching too");

  const { app } = await fixture(t, [() => ({ content: "Done.", toolCalls: [], usage: { input: 5200, output: 40, cachedInput: 4800 } })]);
  const run = await app.runtime.run({ prompt: "say hello" });
  const [completed] = eventsOf(app, run.id, "model.completed");
  assert.equal(completed.cachedInput, 4800, "what the provider served from its cache is recorded");
});

test("a catalog of 150 tools stays small over a long conversation without thrashing compaction", async (t) => {
  const { app, provider } = await fixture(t, [say("Noted.")]);
  const groups = ["data", "research", "media", "channels", "browser", "desktop", "code"];
  for (let i = 0; i < 150; i++) {
    const group = groups[i % groups.length];
    app.registry.register({
      name: `${group}.extra_${i}`,
      description: `Dummy tool ${i} for the guardrail test, with a description of an ordinary length for a tool in this product.`,
      parameters: z.object({ path: z.string().min(1).max(500), count: z.number().int().min(0).max(100).default(1) }).strict(),
      permission: "files.read",
      execute: async () => ({ ok: true }),
    });
  }
  const everything = app.registry.descriptions(new Set(app.registry.permissions()));
  assert.ok(everything.length >= 210, `${everything.length} tools registered`);

  const filler = "we talked about the move and the boxes in the hallway ".repeat(120);
  let sessionId, biggest = 0, compactions = 0;
  for (let round = 0; round < 20; round++) {
    const run = await app.runtime.run({ prompt: `step ${round}: ${filler}`, ...(sessionId ? { sessionId } : {}) });
    assert.equal(run.status, "completed", `round ${round} finished`);
    sessionId = run.sessionId;
    const sent = provider.requests.at(-1);
    const [size] = eventsOf(app, run.id, "catalog.size");
    assert.ok(size.shown <= 40, `round ${round} described ${size.shown} of ${size.tools} tools`);
    const weight = estimateTokens({ messages: sent.messages, tools: sent.tools });
    biggest = Math.max(biggest, weight);
    assert.ok(weight <= contextLimit, `round ${round} weighed ${weight}, over the ${contextLimit} limit`);
    const folds = eventsOf(app, run.id, "context.compacted").length;
    assert.ok(folds <= 1, `round ${round} compacted ${folds} times`);
    compactions += folds;
  }
  assert.ok(biggest > 8000, `the conversation really did grow (${biggest} tokens at its largest)`);
  assert.ok(compactions <= 6, `${compactions} compactions over 20 rounds is not thrashing`);
  assert.ok(compactions >= 1, "and the conversation was long enough for at least one");
});

test("registering another tool does not push an existing one out of an opened toolbox", async (t) => {
  // A new tool used to displace an existing one whenever its name sorted earlier, which broke this
  // file for whoever happened to add the next tool anywhere in the app. Ties now go by registration
  // order instead, so what is already there keeps its place and anything new waits at the back.
  const { app, provider } = await fixture(t, [
    call(expandToolName, { groups: ["schedules"] }),
    call("schedules.list", {}),
    say("Nothing is scheduled."),
  ]);
  for (const name of ["schedules.aaa_added", "schedules.bbb_added", "schedules.ccc_added"])
    app.registry.register({
      name, description: `A tool named ${name}, registered after the ones already here, and sorting before schedules.list.`,
      parameters: z.object({}).strict(), permission: "schedules.read",
      execute: async () => ({ ok: true }),
    });
  await app.runtime.run({ prompt: "tidy the desk" });
  assert.ok(provider.requests[1].tools.includes("schedules.list"),
    "a newly registered tool pushed an existing one out of the opened toolbox");
});
