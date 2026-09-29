/**
 * Files and voice in chat apps beyond Telegram (CHAT-094, 102, 104, 105): the pieces every adapter shares. A file that
 * arrives is fetched only once its message has earned an answer (the router asks for `bytes()`), only from the app's
 * own file host, and never beyond `inboundLimit`; one that goes out is the app's own attachment kind where it has one.
 */
export type AttachmentKind = "picture" | "video" | "document";
/** The largest file fetched from a chat app for a task, as Telegram's own adapter holds it. */
export const inboundLimit = 20 * 1024 * 1024;

export function attachmentKind(mediaType: string): AttachmentKind {
  const type = mediaType.toLowerCase();
  return type.startsWith("image/") ? "picture" : type.startsWith("video/") ? "video" : "document";
}

/** A spoken reply, named so the app shows it as audio. */
export function voiceFileName(mediaType: string): string {
  const type = mediaType.split(";")[0]!.toLowerCase();
  const extension = type.includes("mpeg") || type.includes("mp3") ? "mp3" : type.includes("wav") ? "wav" : type.includes("mp4") || type.includes("m4a") ? "m4a" : "ogg";
  return `reply.${extension}`;
}

/**
 * Fetches a file from an app's own host, refusing any other host, a redirect, or more than `limit` bytes (checked on
 * the declared size first, then on what really arrived).
 */
export async function fetchCapped(fetcher: typeof fetch, url: string, init: RequestInit, hosts: RegExp, what: string,
  declaredSize = 0, limit = inboundLimit): Promise<Uint8Array> {
  const megabytes = Math.round(limit / 1024 / 1024);
  if (declaredSize > limit) throw new Error(`That ${what} is larger than ${megabytes} MB, so it was not downloaded`);
  const target = new URL(url);
  if (target.protocol !== "https:" || !hosts.test(target.hostname)) throw new Error(`That ${what} is not hosted by the chat app, so it was not downloaded`);
  const response = await fetcher(target.href, { ...init, redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`The chat app would not hand over that ${what} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error(`That ${what} is larger than ${megabytes} MB, so it was not used`);
  return bytes;
}
