import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { ProviderStreamError } from "./contracts.js";
import { overflowWordsIn, statedIn } from "./context-words.js";

const quotaCodes = [
  "insufficient_quota",
  "billing_not_active",
  "billing_hard_limit_reached",
  "billing_error",
  "credit_balance_exhausted",
  "spend_limit_exceeded",
  "monthly_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
] as const;
const knownCodes = [
  ...quotaCodes,
  "rate_limit_exceeded",
  "rate_limit_error",
  "slow_down",
  // dogfood D22: a request longer than the model's context window (src/model-context.ts learns the room from it).
  "context_length_exceeded",
] as const;
export type ProviderErrorCode = (typeof knownCodes)[number];

/** A rejected HTTP request; no successful completion body has been consumed. */
export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  readonly code: ProviderErrorCode | undefined;
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    code?: string,
    readonly classificationAvailable = true,
    readonly retryAfterRecognized = true,
    /** Dogfood follow-up: the model's maximum context, in tokens, when the service's refusal stated it. */
    readonly contextLimit?: number,
  ) {
    const safeCode = knownCodes.find((known) => known === code);
    super(
      `Provider HTTP ${status}${safeCode ? ` (${safeCode})` : ""}; check endpoint, model, credential, and quota`,
    );
    this.code = safeCode;
  }
}

export const RetryPolicySchema = z
  .object({
    maxRetries: z.number().int().min(0).max(2).default(2),
    baseDelayMs: z.number().int().min(0).max(5000).default(250),
    maxDelayMs: z.number().int().min(0).max(5000).default(5000),
  })
  .strict()
  .refine(
    (policy) => policy.baseDelayMs <= policy.maxDelayMs,
    "Base retry delay must not exceed maximum delay",
  );
export type RetryPolicyInput = z.input<typeof RetryPolicySchema>;
export type RetryPolicy = Readonly<z.output<typeof RetryPolicySchema>>;
export const parseRetryPolicy = (input: RetryPolicyInput = {}): RetryPolicy =>
  Object.freeze(RetryPolicySchema.parse(input));

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim()))
    return Math.min(Number.MAX_SAFE_INTEGER, Number(value.trim()) * 1000);
  if (
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value.trim(),
    )
  )
    return undefined;
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline) || new Date(deadline).toUTCString() !== value.trim())
    return undefined;
  return Math.max(0, deadline - now);
}

export async function rejectedHttpResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<ProviderHttpError> {
  const read = await readErrorCodes(response);
  signal?.throwIfAborted();
  // A refusal for a request's size is a 400 or 413; a rate limit or an outage that mentions tokens is not an overflow.
  const sized = response.status === 400 || response.status === 413;
  const details = sized ? read : { ...read, codes: read.codes.filter((one) => one !== "context_length_exceeded"), contextLimit: undefined };
  const { codes } = details;
  const code =
    codes.find((value) => quotaCodes.some((quota) => quota === value)) ??
    codes.find((value) => knownCodes.some((known) => known === value));
  const header = response.headers.get("retry-after"),
    retryAfter = parseRetryAfter(header);
  return new ProviderHttpError(
    response.status,
    retryAfter,
    code,
    details.complete,
    header === null || retryAfter !== undefined,
    ...(details.contextLimit ? [details.contextLimit] : []),
  );
}

interface ErrorDetails {
  codes: string[];
  complete: boolean;
  /** Dogfood follow-up: the maximum context a "too long" refusal stated (never the words themselves). */
  contextLimit?: number;
}
const unavailableErrorDetails = (): ErrorDetails => ({
  codes: [],
  complete: false,
});
async function readErrorCodes(response: Response): Promise<ErrorDetails> {
  if (!response.body) return unavailableErrorDetails();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16384) return unavailableErrorDetails();
      chunks.push(next.value);
    }
    return timedOut
      ? unavailableErrorDetails()
      : parseErrorCodes(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return unavailableErrorDetails();
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function parseErrorCodes(body: string): ErrorDetails {
  const shape = z.object({
    error: z.object({
      code: z.string().nullish(),
      type: z.string().nullish(),
      message: z.string().max(4000).nullish(),
    }),
  });
  const parsed = shape.safeParse(JSON.parse(body));
  if (!parsed.success) return unavailableErrorDetails();
  const { code, type, message } = parsed.data.error;
  // Dogfood follow-up: Anthropic says "prompt is too long: N tokens > M maximum" under a general invalid_request_error,
  // and other services say it only in words; any of them is read as the one overflow code, with the maximum it states.
  const overflow = !!message && overflowWordsIn(message);
  const limit = overflow && message ? statedIn(message) : null;
  return {
    codes: [overflow ? "context_length_exceeded" : undefined, code ?? undefined, type ?? undefined].filter(
      (value): value is string => value !== undefined,
    ),
    complete: true,
    ...(limit ? { contextLimit: limit } : {}),
  };
}

/** True for failures where trying another configured model is reasonable: retryable HTTP classes or a failed connection. */
export function fallbackEligible(error: unknown): boolean {
  if (error instanceof Error && error.name === "StallError") return true;
  if (retryableHttpError(error)) return true;
  const cause = error instanceof ProviderStreamError ? error.cause : error;
  return cause instanceof TypeError && /fetch failed/i.test(cause.message);
}

function retryableHttpError(error: unknown): ProviderHttpError | undefined {
  for (
    let depth = 0;
    error instanceof ProviderStreamError && depth < 4;
    depth++
  ) {
    if (error.estimatedOutput > 0 || error.usage !== undefined)
      return undefined;
    error = error.cause;
  }
  if (
    !(error instanceof ProviderHttpError) ||
    !error.retryAfterRecognized ||
    quotaCodes.some((code) => code === error.code)
  )
    return undefined;
  if (![408, 429, 500, 502, 503, 504, 529].includes(error.status))
    return undefined;
  if (error.status === 429 && !error.classificationAvailable) return undefined;
  if (
    error.status === 429 &&
    error.retryAfterMs === undefined &&
    error.code !== "rate_limit_exceeded" &&
    error.code !== "slow_down"
  )
    return undefined;
  return error;
}

export function planRetry(
  error: unknown,
  retriesUsed: number,
  policy: RetryPolicy,
): { status: number; delayMs: number } | undefined {
  const failure = retryableHttpError(error);
  if (!failure || retriesUsed >= policy.maxRetries) return undefined;
  const delayMs = Math.max(
    policy.baseDelayMs * 2 ** retriesUsed,
    failure.retryAfterMs ?? 0,
  );
  if (!Number.isFinite(delayMs) || delayMs > policy.maxDelayMs)
    return undefined;
  return { status: failure.status, delayMs };
}

export async function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  await wait(delayMs, undefined, { signal });
}

/**
 * mac7/speed: what a person is told when the model service refuses.
 *
 * `Provider HTTP 400; check endpoint, model, credential, and quota` is the right thing to write in
 * the event log and the wrong thing to leave somebody as the whole answer to their request — which
 * is what happened in the five-way window: one task ended on that sentence and nothing else, while
 * the other two assistants finished the same task on the same endpoint minutes apart.
 *
 * Nothing here is a guess about what went wrong; each sentence says only what the status code
 * means and where the person can look. The technical text is kept beside it in the record.
 */
export function providerRefusal(error: unknown): string | null {
  // A refusal that arrives mid-stream is wrapped (`ProviderStreamError` carries the original as its
  // cause), and that is the shape the plan's own failure took, so the wrapper is opened here. One
  // layer only: anything deeper is not this.
  const refusal = error instanceof ProviderHttpError ? error
    : (error as { cause?: unknown })?.cause instanceof ProviderHttpError ? (error as { cause: ProviderHttpError }).cause
    : null;
  if (!refusal) return null;
  const status = refusal.status;
  const where = "You can check the connection in Settings, under Models.";
  if (status === 401 || status === 403)
    return `The model service would not accept this connection's sign-in. ${where}`;
  if (status === 404)
    return `The model service does not know the model this connection asks for. ${where}`;
  if (status === 429)
    return "The model service asked to be left alone for a while — usually a rate limit or a spent quota. Try again shortly.";
  if (status >= 500)
    return "The model service had a problem at its end. Nothing here is wrong; trying again usually works.";
  if (status >= 400)
    return `The model service refused this request (${status}). That is usually the connection's model or one of its settings rather than anything about what you asked. ${where}`;
  return null;
}
