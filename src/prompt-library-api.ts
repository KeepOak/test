import { z } from "zod";
import type { createBranch } from "./index.js";
import {
  exportPrompts, importPrompts, listPrompts, promptGroups, promptLibrarySettings, removePrompt, savePrompt,
  savePromptLibrarySettings, assertLibraryOn, blanksIn, fillPrompt,
} from "./prompt-library.js";
import { EXAMPLES, addExamples, exampleMcpConfig } from "./prompt-examples.js";
import { takenByCatalog } from "./commands/saved.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * Bucket 12: the routes behind "Your saved prompts" (Automations › Procedures).
 *
 *   GET  /api/prompts                 the switch, the prompts in their groups, and the examples on offer
 *   GET  /api/prompts/export          the whole library as one file
 *   POST /api/prompts                 save a prompt (new, or a new wording of one)
 *   POST /api/prompts/settings        the three-way switch
 *   POST /api/prompts/remove          take one out
 *   POST /api/prompts/import          add the prompts of a library file
 *   POST /api/prompts/examples        add the starter prompts
 *   POST /api/prompts/try             try a wording on one or two models, before saving it
 *
 * Every change is the owner's alone: a short-lived key is refused before it gets here
 * (src/short-lived-keys.ts lists none of these), and the owner's own profile is asked for as well.
 * Trying a wording asks the model with no tools at all, in a conversation nobody keeps.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export const handlesPromptsPath = (path: string): boolean => path === "/api/prompts" || path.startsWith("/api/prompts/");

export const TryPromptSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(4000)).default({}),
  input: z.string().max(4000).default(""),
  /** One model, or two to set side by side; none means the one new conversations start with. */
  models: z.array(z.string().min(1).max(100)).max(2).default([]),
}).strict();
const trying = new Set<string>();

function view(app: Branch) {
  const { store } = app, owner = app.runtime.owner;
  // Q259: only the owner saves prompts, so a household person at the window is sent none of theirs (the "/" menu is empty).
  const prompts = (store.profiles.isOwner() ? listPrompts(store, owner) : []).map((prompt) => ({ ...prompt, blanks: blanksIn(prompt.body) }));
  return {
    settings: promptLibrarySettings(store, owner), prompts, groups: promptGroups(prompts),
    examples: EXAMPLES.map(({ title, description, command }) => ({ title, description, command })),
    exampleServer: { mcp: [exampleMcpConfig()] },
  };
}

async function tryPrompt(app: Branch, input: unknown) {
  const { runtime } = app, owner = runtime.owner;
  assertLibraryOn(app.store, owner);
  const value = TryPromptSchema.parse(input);
  const message = fillPrompt(value.body, value.values, value.input);
  const models = value.models.length ? value.models : [""];
  for (const id of models) if (id && !runtime.models.presets.has(id)) throw new Error(`No model called ${id}.`);
  if (trying.has(owner)) throw new Error("A try is already running; wait for its answer first.");
  trying.add(owner);
  try {
    const answers = [];
    for (const id of models) {
      const started = Date.now();
      // Integrator (bucket 12): no tools, one answer, a bounded spend; the monthly budget is checked by run().
      const run = await runtime.run({ prompt: message, temporary: true, permissions: [], budget: { maxSteps: 2, maxTokens: 32000 },
        ...(id ? { model: id } : {}), onTextDelta: () => undefined });
      answers.push({ model: id || null, status: run.status, output: runtime.hideSecrets(run.output), milliseconds: Date.now() - started });
    }
    return { message, answers };
  } finally { trying.delete(owner); }
}

async function change(app: Branch, path: string, body: unknown): Promise<unknown> {
  const { store } = app, owner = app.runtime.owner;
  app.store.profiles.requireOwner("Your saved prompts");
  if (path === "/api/prompts") return savePrompt(store, owner, body, takenByCatalog);
  if (path === "/api/prompts/settings")
    return recordedWrite(store, owner, byCard("prompt-library"), ["prompt-library"], () => savePromptLibrarySettings(store, owner, body));
  if (path === "/api/prompts/remove") return removePrompt(store, owner, z.object({ id: z.string().uuid() }).strict().parse(body).id);
  if (path === "/api/prompts/import") return importPrompts(store, owner, body, takenByCatalog);
  if (path === "/api/prompts/examples") { assertLibraryOn(store, owner); return addExamples(store, owner, takenByCatalog); }
  if (path === "/api/prompts/try") return tryPrompt(app, body);
  return undefined;
}

/** Answers one request under /api/prompts, or undefined when the address is not one of these. */
export async function promptsApi(app: Branch, method: string, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  if (method === "GET" && path === "/api/prompts") return view(app);
  if (method === "GET" && path === "/api/prompts/export") {
    // Q259: the saved prompts are the owner's; a household person at the window has none to save (as /prompts says).
    app.store.profiles.requireOwner("Your saved prompts");
    return exportPrompts(app.store, app.runtime.owner);
  }
  if (method !== "POST") return undefined;
  return change(app, path, await readBody());
}
