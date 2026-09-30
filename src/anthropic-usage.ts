import { z } from "zod";
import type { Usage } from "./contracts.js";

const tokens = z.number().int().nonnegative().nullish();

/**
 * What Anthropic says a call used. Its `input_tokens` leaves out the tokens read from and written to the prompt cache,
 * which are counted apart (cache_read_input_tokens, cache_creation_input_tokens, and, when the request used the
 * one-hour cache, cache_creation.ephemeral_5m/1h_input_tokens). Every field can be missing or null.
 */
export const AnthropicUsageSchema = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  cache_creation_input_tokens: tokens,
  cache_read_input_tokens: tokens,
  cache_creation: z.object({ ephemeral_5m_input_tokens: tokens, ephemeral_1h_input_tokens: tokens }).nullish(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;

/**
 * Anthropic's counts in Branch's shape: `input` is the whole prompt (as OpenAI's prompt_tokens is, and as the Claude
 * subscription capture already reports it), with the cache reads and writes as parts of it, so a budget or a cap sees
 * every token the call was charged for and pricing can charge each part at its own rate (src/pricing.ts).
 */
export function anthropicUsage(said: AnthropicUsage, output = said.output_tokens ?? 0): Usage {
  const read = said.cache_read_input_tokens ?? 0;
  const detail = said.cache_creation;
  const split = (detail?.ephemeral_5m_input_tokens ?? 0) + (detail?.ephemeral_1h_input_tokens ?? 0);
  const write = Math.max(said.cache_creation_input_tokens ?? 0, split);
  const hour = Math.min(write, detail?.ephemeral_1h_input_tokens ?? 0);
  return {
    input: (said.input_tokens ?? 0) + read + write,
    output,
    ...(said.cache_read_input_tokens != null ? { cachedInput: read } : {}),
    ...(said.cache_creation_input_tokens != null || detail ? { cacheWrite: write } : {}),
    ...(hour > 0 ? { cacheWrite1h: hour } : {}),
  };
}
