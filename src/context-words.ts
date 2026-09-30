/**
 * Dogfood follow-up (context limits): reading a model service's own words about a request that was too long. No
 * imports, so the HTTP layer (src/provider-retry.ts) and the room (src/model-context.ts) can both use it.
 */
/**
 * The words services use when a request is longer than the model's window: OpenAI's code and message, Anthropic's
 * "prompt is too long", Gemini's "exceeds the maximum number of tokens", and the plain "context window" and "context
 * length" phrasings other services and mid-stream failures use.
 */
export const overflowWords = /context_length_exceeded|prompt is too long|prompt too long|maximum context length|context (?:length|window) (?:exceeded|of)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|input (?:is )?too long|too many (?:input )?tokens|exceeds the maximum number of tokens|request too large for model/i;
/** A maximum the service stated in its words: "maximum context length is 128000", "> 200000 maximum", "window of 32768". */
const statedWords = /(?:maximum context length is|context window of|limit of|>\s*)\s*([0-9][0-9,]{3,})(?:\s*tokens?)?(?:\s*maximum)?/i;

/** The maximum a service's own words state, in tokens, or null. */
export function statedIn(words: string): number | null {
  const found = statedWords.exec(words);
  const value = found ? Number(found[1]!.replace(/,/g, "")) : NaN;
  return Number.isFinite(value) && value >= 1024 && value <= 20_000_000 ? value : null;
}
/** Whether a service's error words describe an overflow (used when reading an HTTP refusal's body). */
export const overflowWordsIn = (words: string): boolean => overflowWords.test(words);
