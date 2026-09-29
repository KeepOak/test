import type { ChatGPTAuth } from "./chatgpt-auth.js";
import { ChatGPTProvider, chatgptModels } from "./chatgpt-provider.js";
import type { ModelRouter } from "./models.js";
import { demoProviderName } from "./demo.js";

export const chatgptPresetPrefix = "chatgpt-";

/**
 * The Terms line for this route. OpenAI documents ChatGPT sign-in only for its own apps
 * (https://learn.chatgpt.com/docs/auth) and no written permission for other apps was found, so the
 * route says so in the sign-in dialog (its standing and warning). Its name is plain, "ChatGPT · <model>" (the owner,
 * 2026-09-27): never a suffix in names or labels. It is only ever used after the owner signs in.
 */
export const chatgptTerms = {
  route: "ChatGPT plan sign-in (OpenAI's device-code sign-in)",
  url: "https://openai.com/policies/row-terms-of-use/",
  standing: "unofficial",
  warning: "Unofficial: OpenAI documents this sign-in only for its own apps, so it may stop working at any time. An API key is the officially supported way.",
} as const;
export const chatgptPresetId = (model: string): string => chatgptPresetPrefix + model.replace(/[^a-z0-9.]+/gi, "-");

/**
 * Keeps the model presets in step with the ChatGPT sign-in: signed in adds one preset per supported
 * model, signed out removes them. Returns the ids currently registered for ChatGPT.
 */
export function syncChatGPTPresets(models: ModelRouter, auth: ChatGPTAuth, signedIn: boolean, userAgent: string): string[] {
  if (!signedIn) {
    models.unregister(chatgptPresetPrefix);
    return [];
  }
  return chatgptModels.map((entry) => {
    const id = chatgptPresetId(entry.id);
    models.register({
      id, name: `ChatGPT · ${entry.label}`, model: entry.id, reasoning: entry.reasoning,
      // Its answers are watched like any connection's, so the plan window ChatGPT reports on them is read.
      provider: new ChatGPTProvider(auth, { model: entry.id, userAgent, fetch: models.health.watch(id) }),
    });
    return id;
  });
}

/** After a sign-in, make ChatGPT the default when no other model was chosen yet (or only the tests' scripted fixture). */
export function preferChatGPTAfterSignIn(models: ModelRouter, owner: string, ids: string[]): void {
  const first = ids[0];
  if (!first) return;
  const settings = models.settings(owner);
  const current = models.presets.get(settings.activePreset ?? models.default.id);
  if (!current || current.provider.name === demoProviderName)
    models.configure(owner, { activePreset: first, fallbackOrder: ids.slice(1).filter((id) => id !== chatgptPresetId("gpt-6-astra")) });
}

/** Waits for the browser approval, then registers ChatGPT presets and prefers them over having no model chosen. */
export async function finishChatGPTSignIn(models: ModelRouter, auth: ChatGPTAuth, owner: string, userAgent: string) {
  const status = await auth.waitForDeviceLogin();
  const ids = syncChatGPTPresets(models, auth, status.signedIn, userAgent);
  preferChatGPTAfterSignIn(models, owner, ids);
  return status;
}
