import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { ImageEndpoint } from "./media-images.js";
import { maxArtifactBytes } from "./artifacts.js";

/** One bounded, documented Lyria clip. No arbitrary music endpoint or silently selected provider. */
export const MusicRequestSchema = z.object({
  connection: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  prompt: z.string().trim().min(1).max(4000),
  instrumental: z.boolean().default(false),
  save: z.string().trim().max(100).regex(/^[a-z0-9][a-z0-9._-]*\.mp3$/i, "Use a simple file name ending in .mp3").optional(),
}).strict();
export type MusicRequest = z.infer<typeof MusicRequestSchema>;
export const musicClipModel = "lyria-3-clip-preview";
const maxEncoded = Math.ceil(maxArtifactBytes / 3) * 4;
const maxResponse = maxEncoded + 128 * 1024;
const MusicResponseSchema = z.object({ candidates: z.array(z.object({ content: z.object({
  parts: z.array(z.object({ text: z.string().max(40000).optional(), inlineData: z.object({
    mimeType: z.enum(["audio/mpeg", "audio/mp3"]),
    data: z.string().min(1).max(maxEncoded).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0),
  }).optional() })).max(24),
}) })).min(1).max(4) });

/** Read under a cap before parsing, including responses that have no content-length header. */
async function musicJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The music service refused the request (${response.status}). Check this connection's music access.`); }
  if (Number(response.headers.get("content-length")) > maxResponse) {
    await response.body?.cancel(); throw new Error("The music response is larger than the artifact limit.");
  }
  if (!response.body) throw new Error("The music service sent an empty response.");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxResponse) { await reader.cancel(); throw new Error("The music response is larger than the artifact limit."); }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/** Official Google API-key route only; credentials never ride in the URL, and redirects never receive them. */
export async function generateMusicClip(where: ImageEndpoint, request: MusicRequest, policy: NetworkPolicy,
  fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<{ bytes: Buffer; lyrics: string }> {
  const endpoint = new URL(where.endpoint);
  if (where.kind !== "gemini" || where.bearer || !where.apiKey || endpoint.origin !== "https://generativelanguage.googleapis.com"
    || endpoint.username || endpoint.password)
    throw new Error("Music needs a Google Gemini connection with an API key at Google's own address.");
  signal.throwIfAborted();
  const url = `${endpoint.origin}/v1beta/models/${musicClipModel}:generateContent`;
  const response = await policy.guard(fetch)(url, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", "x-goog-api-key": where.apiKey },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: request.prompt
      + (request.instrumental ? "\nInstrumental only, no vocals." : "") }] }] }),
  });
  const parsed = MusicResponseSchema.safeParse(await musicJson(response));
  if (!parsed.success) throw new Error("The music service did not return a supported MP3 clip.");
  const parts = parsed.data.candidates[0]!.content.parts;
  const sound = parts.find((part) => part.inlineData)?.inlineData;
  if (!sound) throw new Error("The music service answered without a sound file.");
  const bytes = Buffer.from(sound.data, "base64");
  if (bytes.length < 10 || bytes.length > maxArtifactBytes
    || !(bytes.subarray(0, 3).toString("ascii") === "ID3" || bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    throw new Error("The music service did not return an MP3 under the artifact size limit.");
  signal.throwIfAborted();
  return { bytes, lyrics: parts.map((part) => part.text ?? "").filter(Boolean).join("\n").slice(0, 10000) };
}
