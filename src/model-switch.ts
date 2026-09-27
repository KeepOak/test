import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ModelRouter } from "./models.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * Changing which model answers, in the middle of a conversation, without restarting anything. The
 * change belongs to that one conversation: every other conversation, and the workspace default,
 * are left exactly as they were, and the next reply is charged at the new model's prices.
 */
export interface SwitchResult {
  sessionId: string;
  preset: string | null;
  presetName: string;
  model: string;
  /** What the person is told, in plain words. */
  message: string;
}

/** Finds a connection by its short name or by what it is called on screen; case does not matter. */
export function findPreset(models: ModelRouter, wanted: string): string | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  for (const preset of models.presets.values()) if (preset.id.toLowerCase() === needle) return preset.id;
  for (const preset of models.presets.values()) if (preset.name.toLowerCase() === needle) return preset.id;
  for (const preset of models.presets.values()) if (preset.model.toLowerCase() === needle) return preset.id;
  const partial = [...models.presets.values()].filter((preset) =>
    preset.name.toLowerCase().includes(needle) || preset.id.toLowerCase().includes(needle) || preset.model.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0]!.id : null;
}

/** What `/model` in the message box means. An empty argument is a request to see the list. */
export function parseModelCommand(line: string): { list: true } | { list: false; wanted: string } | null {
  const match = /^\/model(?:\s+(.*))?$/i.exec(line.trim());
  if (!match) return null;
  const wanted = (match[1] ?? "").trim();
  return wanted && wanted !== "?" ? { list: false, wanted } : { list: true };
}

/**
 * Points one conversation at a different connection. "default" puts it back to whatever the
 * workspace uses, which is how a person undoes a switch without knowing any names. Q261: for a household person at
 * the window, `names: false` leaves the owner's connection names out of the answer to a wrong name, and `holder` is
 * their profile when the conversation is filed under it (the choice is still kept under the owner, in whose name
 * their tasks run).
 */
export function switchModel(models: ModelRouter, owner: string, sessionId: string, wanted: string,
  options: { names: boolean; holder?: string } = { names: true }): SwitchResult {
  const holder = options.holder ?? owner;
  const asked = wanted.trim();
  if (!asked || asked.toLowerCase() === "default" || asked.toLowerCase() === "reset") {
    models.configureSession(owner, sessionId, { preset: null }, holder);
    const now = models.plan(owner, sessionId).choice;
    return { sessionId, preset: null, presetName: now.presetName, model: now.model,
      message: `This conversation is back to the usual choice: ${now.presetName} (${now.model}).` };
  }
  const id = findPreset(models, asked);
  if (!id) {
    if (!options.names) throw new Error(`There is no connection called "${asked}".`);
    const names = [...models.presets.values()].map((preset) => preset.name).join(", ");
    throw new Error(`There is no connection called "${asked}". You have: ${names}.`);
  }
  models.configureSession(owner, sessionId, { preset: id }, holder);
  const now = models.plan(owner, sessionId).choice;
  return { sessionId, preset: id, presetName: now.presetName, model: now.model,
    message: `This conversation now uses ${now.presetName} (${now.model}). Everything else is unchanged.` };
}

/** The connections a person can pick between, for the list `/model` on its own prints. */
export function listModels(models: ModelRouter, owner: string, sessionId: string) {
  const active = models.plan(owner, sessionId).choice;
  return {
    active: active.presetId,
    choices: [...models.presets.values()].map((preset) => ({
      id: preset.id, name: preset.name, model: preset.model,
      onThisComputer: models.runsLocally(preset.id),
      resting: models.coolingDown(preset.id),
    })),
  };
}

/**
 * The `models.switch` tool. A tool only knows which task it is part of, so the conversation is
 * looked up from the task, and a task with no conversation behind it is refused in plain words.
 */
export function registerModelSwitch(registry: ToolRegistry, store: Store, models: ModelRouter): void {
  registry.register({
    name: "models.switch", permission: "models.switch",
    description: "Change which model answers in this conversation, without restarting anything. Use the connection's name, or \"default\" to put it back. Other conversations are not affected.",
    parameters: z.object({ model: z.string().trim().min(1).max(120) }).strict(),
    target: (input) => `the model for this conversation (${input.model})`,
    execute: async (input: { model: string }, context: ToolContext) => {
      const sessionId = store.run(context.runId)?.sessionId;
      if (!sessionId) throw new Error("This task is not part of a conversation, so there is no model to change here.");
      if (context.dryRun) return { wouldSwitchTo: input.model, sessionId };
      return switchModel(models, context.owner, sessionId, input.model);
    },
  });
}
