/**
 * mac7/nodes: the phone as one of the owner's devices. It pairs with the Devices card's invitation,
 * keeps its own Ed25519 key (made here with WebCrypto, never exported), dials Branch's device socket
 * and does only what the owner switched on for this phone, while the app is open.
 *
 * It uses what a Capacitor web view already has, so no new plugin is needed for:
 *   camera   getUserMedia + a canvas frame          listen  getUserMedia + MediaRecorder
 *   location navigator.geolocation                  speak   speechSynthesis
 *   open-url window.open                            canvas  a sealed frame on the home screen
 * Not offered on phones until a plugin is added (see docs/configuration.md, "Devices"): notifications
 * (@capacitor/local-notifications), the clipboard in the background (@capacitor/clipboard), and
 * anything while the app is closed (no background socket without a native service).
 *
 * Every browser and system call is passed in (`env`), so the same code is tested in Node with fakes.
 *
 * mac7/phone-pairing: what the phone app actually ships is the native pairing (BranchPhonePlugin),
 * because the app page may only talk to itself (the page's Content-Security-Policy). This module
 * stays the written-down protocol, proved against a real Branch in tests/devices-phone.test.mjs, and
 * is what a future socket will use. Both sides keep the same two rules: the address rule
 * (rules.js `checkAddress`) and the phone's own "never allow" list, which can only take away.
 */
import { checkAddress, readNever } from "./rules.js";

const PROTOCOL = 1;
const MEDIA_LIMIT = 8 * 1024 * 1024;
export const PHONE_OFFERS = ["camera", "location", "open-url", "speak", "listen", "canvas"];
/** What this phone offers Branch: what it can do, less what the owner told it here never to do. */
export const offersLess = (never) => PHONE_OFFERS.filter((capability) => !readNever(never).includes(capability));

const text = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const hexOk = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

/** Makes (or reuses) the phone's key. `store` keeps the CryptoKey pair itself; the private half is not extractable. */
export async function phoneKey(env) {
  const kept = await env.store.get("device-key");
  if (kept) return kept;
  const pair = await env.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const publicKey = b64(await env.crypto.subtle.exportKey("spki", pair.publicKey));
  const key = { privateKey: pair.privateKey, publicKey };
  await env.store.set("device-key", key);
  return key;
}
async function signed(env, key, message) {
  return b64(await env.crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, text.encode(message)));
}

/** Answers an invitation from a scanned link and the typed number, then waits for the owner's yes. */
export async function pairPhone(env, link, code, name, never = []) {
  return (await answerInvitation(env, link, code, name, never)).deviceId;
}

/**
 * B6: connecting from the window's "Pair a phone" square, as the native side does it (BranchPhonePlugin phonePair).
 * The phone answers the invitation and waits for the owner's yes as above, then collects its session once, signed
 * with the same key over "branch-phone-session-v1" and the request id (src/devices/book.ts collectPhoneSession).
 * Answers { token, deviceId, deviceKey }: the session a /pair invitation hands over, kept natively, never on a page.
 */
export async function pairPhoneSession(env, link, code, name, never = []) {
  const { requestId, key, post } = await answerInvitation(env, link, code, name, never);
  return post("/api/devices/pair/session", { requestId, signature: await signed(env, key, `branch-phone-session-v1\n${requestId}`) });
}

async function answerInvitation(env, link, code, name, never) {
  const url = new URL(link);
  const offer = url.searchParams.get("offer") ?? "";
  if (!hexOk(offer, 32)) throw new Error(env.say("phone.node.badLink", "That is not a pairing link from Branch's Devices card."));
  // The same address rule as the rest of the phone: https anywhere, plain http only to this
  // network or a Tailscale address. Checked here as well as natively, never instead of it.
  checkAddress(url.origin);
  const key = await phoneKey(env);
  const post = async (path, body) => {
    const response = await env.fetch(`${url.origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error ?? `Branch answered ${response.status}`);
    return answer;
  };
  const { requestId } = await post("/api/devices/pair", { offer, code, name, platform: env.platform, publicKey: key.publicKey, offers: offersLess(never) });
  for (let tries = 0; tries < (env.tries ?? 200); tries++) {
    const status = await post("/api/devices/pair/status", { requestId, signature: await signed(env, key, `branch-node-status-v1\n${requestId}`) });
    if (status.status === "approved") {
      await env.store.set("device", { hub: url.origin, id: status.deviceId, never: readNever(never) });
      return { origin: url.origin, requestId, key, post, deviceId: status.deviceId };
    }
    if (status.status === "refused") throw new Error(env.say("phone.node.refused", "The owner refused this phone."));
    await env.wait(3000);
  }
  throw new Error(env.say("phone.node.late", "Nobody answered in time. Make a new invitation and try again."));
}

async function capture(env, capability, args) {
  if (capability === "camera") {
    const stream = await env.media.getUserMedia({ video: { facingMode: args.facing === "front" ? "user" : "environment" } });
    try { return { mime: "image/jpeg", name: "camera.jpg", data: await env.frame(stream) }; } finally { stream.getTracks().forEach((track) => track.stop()); }
  }
  const stream = await env.media.getUserMedia({ audio: true });
  try { return { mime: "audio/webm", name: "listen.webm", data: await env.record(stream, Math.min(30, Number(args.seconds ?? 5)) * 1000) }; }
  finally { stream.getTracks().forEach((track) => track.stop()); }
}

/** Does one switched-on thing. Arguments are checked again here, whatever Branch sent. */
export async function perform(env, capability, args = {}) {
  if (capability === "camera" || capability === "listen") return { value: { captured: capability }, media: await capture(env, capability, args) };
  if (capability === "location") {
    const where = await new Promise((resolve, reject) => env.geolocation.getCurrentPosition(resolve, reject, { timeout: 15000, maximumAge: 60000 }));
    return { value: { latitude: where.coords.latitude, longitude: where.coords.longitude, accuracyMeters: where.coords.accuracy ?? null } };
  }
  if (capability === "open-url") {
    if (!/^https?:\/\//i.test(String(args.url ?? ""))) throw new Error("Only web addresses can be opened.");
    env.open(String(args.url));
    return { value: { done: "opened" } };
  }
  if (capability === "speak") { env.speak(String(args.text ?? "").slice(0, 2000)); return { value: { done: "spoken" } }; }
  if (capability === "canvas") {
    // Integration review: checked here too, so a hub that was taken over cannot show a javascript: or file: address.
    const html = typeof args.html === "string" && args.html ? args.html.slice(0, 60000) : null;
    const url = typeof args.url === "string" && args.url ? args.url : null;
    if (Boolean(html) === Boolean(url)) throw new Error("Give either a page or an address.");
    if (url && !/^https?:\/\//i.test(url)) throw new Error("Only web addresses can be shown.");
    env.showPage({ html, url });
    return { value: { done: "shown" } };
  }
  throw new Error("This phone does not do that.");
}

/**
 * Stays connected while the app is open; dials again with a growing wait when the line drops.
 * Returns a function that stops it.
 */
export function connectPhone(env, device, key, onState = () => undefined) {
  let enabled = new Set(), stopped = false, attempt = 0, socket = null;
  const never = readNever(device.never), offers = offersLess(device.never);
  const seen = new Set();
  const dial = () => {
    if (stopped) return;
    const address = new URL("/api/devices/socket", device.hub);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    address.searchParams.set("device", device.id);
    socket = new env.WebSocket(address.href);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => void onMessage(JSON.parse(event.data));
    socket.onclose = () => {
      enabled = new Set();
      onState({ connected: false, enabled: [] });
      if (stopped) return;
      attempt += 1;
      env.later(dial, Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1)));
    };
  };
  const reply = (value) => socket.send(JSON.stringify(value));
  async function onMessage(frame) {
    if (frame.type === "challenge") {
      reply({ type: "hello", version: PROTOCOL, deviceId: device.id, platform: env.platform, offers,
        signature: await signed(env, key, `branch-node-hello-v1\n${device.id}\n${frame.nonce}`) });
    } else if (frame.type === "welcome" || frame.type === "enabled") {
      attempt = 0;
      enabled = new Set((frame.enabled ?? []).filter((c) => offers.includes(c)));
      onState({ connected: true, enabled: [...enabled] });
    } else if (frame.type === "invoke") {
      await invoke(frame);
    } else if (frame.type === "bye" && /taken off/.test(String(frame.reason))) {
      stopped = true;
      await env.store.set("device", null);
    }
  }
  async function invoke(frame) {
    const refuse = (error) => reply({ type: "result", id: frame.id, ok: false, error });
    if (!hexOk(frame.id, 32) || seen.has(frame.id)) return;
    seen.add(frame.id);
    // Looked at again here: Branch switches a capability on by what the platform can do, not by what
    // this phone offered, so a refused one can still arrive. The phone turns it away itself.
    if (never.includes(frame.capability)) return refuse("This phone never allows that.");
    if (!enabled.has(frame.capability)) return refuse("That is switched off on this phone.");
    if (typeof frame.deadline !== "number" || frame.deadline < env.now()) return refuse("The request came too late.");
    try {
      const result = await perform(env, frame.capability, frame.args ?? {});
      if (!result.media) return reply({ type: "result", id: frame.id, ok: true, value: result.value });
      const bytes = new Uint8Array(result.media.data);
      if (bytes.length > MEDIA_LIMIT) return refuse("The picture or sound was larger than Branch accepts.");
      reply({ type: "result", id: frame.id, ok: true, value: result.value, media: { mime: result.media.mime, bytes: bytes.length, name: result.media.name } });
      const framed = new Uint8Array(32 + bytes.length);
      framed.set(text.encode(frame.id), 0);
      framed.set(bytes, 32);
      socket.send(framed);
    } catch (error) {
      refuse(String(error?.message ?? error).slice(0, 500));
    }
  }
  dial();
  return () => { stopped = true; socket?.close(); };
}
