import type { Completion, Provider } from "./contracts.js";
import type { ModelPreset } from "./models.js";

/** What a task is told when no model has been set up: the words the window and every other surface show as they are. */
export const noModelWords = "No model yet. Choose one in setup or in Settings › Models.";
export const noModelProviderName = "no-model";

/**
 * Stands where a model would be until the person sets one up. It is never listed as a model: it only answers every
 * request with the refusal above, so a message sent before setup fails in plain words instead of meeting a made-up model.
 */
export class NoModelProvider implements Provider {
  readonly name = noModelProviderName;
  audio(): null {
    return null;
  }
  async complete(): Promise<Completion> {
    throw new Error(noModelWords);
  }
}

/**
 * The stand-in the model router answers with while it holds no connection. Its name is what a status line shows in
 * place of a model's name (the terminal's foot, `/status`), so it says there is none.
 */
export const noModelPreset = (): ModelPreset => ({ id: "none", name: "No model yet", provider: new NoModelProvider(), model: "" });
