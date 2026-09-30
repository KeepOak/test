import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./server-http.js";

/** Twilio documented sorted-parameter HMAC-SHA1; SDK pattern reviewed, no new dependency. */
export async function signedTwilioForm(request: IncomingMessage, publicUrl: string, token: string): Promise<URLSearchParams> {
  if (request.method !== "POST" || !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new HttpError(415, "Use signed Twilio form POST");
  let body = "";
  for await (const chunk of request) { body += Buffer.from(chunk).toString("utf8"); if (Buffer.byteLength(body) > 16_384) throw new HttpError(413, "Voice callback exceeds bound"); }
  const form = new URLSearchParams(body), names = [...new Set(form.keys())].sort();
  // Reject ambiguous duplicates rather than letting one signature authenticate a different parsed value.
  if (names.some((name) => form.getAll(name).length !== 1)) throw new HttpError(400, "Duplicate callback parameter");
  const data = publicUrl + names.map((name) => name + form.get(name)!).join("");
  const expected = Buffer.from(createHmac("sha1", token).update(data).digest("base64"));
  const header = request.headers["x-twilio-signature"], actual = Buffer.from(typeof header === "string" ? header : "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(403, "Invalid Twilio signature");
  return form;
}
export const escapeTwiml = (text: string): string => text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
export const hangupTwiml = '<?xml version="1.0"?><Response><Hangup/></Response>';
