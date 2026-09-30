import { randomUUID } from "node:crypto";
import { z } from "zod";
import { maximumImageBytes } from "./contracts.js";
import { chatgptDefaults } from "./chatgpt-auth.js";
import type { NetworkPolicy } from "./network-policy.js";
import { decodePng } from "./media-decode.js";
import { imagePromptText, type ImageRequest, type MadePicture, type SourcePicture } from "./media-images.js";

/** Request contract reviewed in Apache-2.0 Codex codex-api images.rs; original Branch adapter. */
export const codexImageModel = "gpt-image-2";
export interface CodexImageEndpoint {
  endpoint: string;
  token: string;
  accountId: string;
  originator: string;
  userAgent: string;
}
export interface CodexPicture extends MadePicture { width: number; height: number }
const maximumBase64 = Math.ceil(maximumImageBytes / 3) * 4;
const responseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1).max(maximumBase64) })).length(1) });

async function boundedResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The ChatGPT picture service refused the request (HTTP ${response.status}).`); }
  if (!response.body) throw new Error("The ChatGPT picture service returned no picture.");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBase64 + 65536) throw new Error("The ChatGPT picture response exceeds the 5 MB image limit.");
      chunks.push(Buffer.from(part.value));
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("The ChatGPT picture service returned malformed JSON."); }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Native Codex JSON generation/edit route, distinct from the API-key multipart edit route. */
export async function generateCodexImage(
  where: CodexImageEndpoint, request: ImageRequest, source: SourcePicture | null,
  policy: NetworkPolicy, fetch: typeof globalThis.fetch, signal: AbortSignal,
): Promise<CodexPicture> {
  signal.throwIfAborted();
  if (where.endpoint !== chatgptDefaults.apiBase || !where.accountId || !where.token)
    throw new Error("ChatGPT pictures need an account-bound sign-in at the original ChatGPT address.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(where.accountId) || !/^[A-Za-z0-9._~+\/-]+=*$/.test(where.token))
    throw new Error("The ChatGPT sign-in returned invalid picture credentials.");
  if (request.edit?.mask) throw new Error("ChatGPT picture edits do not support a mask here; use an API-key picture connection for masks.");
  const body: Record<string, unknown> = { model: codexImageModel, prompt: imagePromptText(request), n: 1,
    quality: "auto", size: request.size, background: "opaque" };
  if (source) {
    if (source.bytes.length > maximumImageBytes || !["image/png", "image/jpeg", "image/webp"].includes(source.mediaType))
      throw new Error("A ChatGPT edit source must be a PNG, JPEG or WebP picture up to 5 MB.");
    if (source.mediaType === "image/png") decodePng(source.bytes);
    else if (source.mediaType === "image/jpeg" && !source.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
      throw new Error("The edit source is not a JPEG picture.");
    else if (source.mediaType === "image/webp" && (source.bytes.toString("ascii", 0, 4) !== "RIFF" || source.bytes.toString("ascii", 8, 12) !== "WEBP"))
      throw new Error("The edit source is not a WebP picture.");
    body.images = [{ image_url: `data:${source.mediaType};base64,${source.bytes.toString("base64")}` }];
  }
  const response = await policy.guard(fetch)(`${where.endpoint}/images/${source ? "edits" : "generations"}`, {
    method: "POST", signal, redirect: "error",
    headers: { authorization: `Bearer ${where.token}`, "chatgpt-account-id": where.accountId,
      originator: where.originator, "user-agent": where.userAgent, "content-type": "application/json", "x-codex-image-turn-id": randomUUID() },
    body: JSON.stringify(body),
  });
  const encoded = responseSchema.parse(await boundedResponse(response, signal)).data[0]!.b64_json;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("The ChatGPT picture service returned malformed image data.");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maximumImageBytes) throw new Error("The ChatGPT picture exceeds the 5 MB image limit.");
  const decoded = decodePng(bytes);
  signal.throwIfAborted();
  return { bytes, mediaType: "image/png", width: decoded.width, height: decoded.height };
}
