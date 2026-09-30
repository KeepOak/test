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
/**
 * PH-03: what the phone apps really do when lent. The app's own page takes camera photos, records and speaks:
 * camera and microphone on both, speaking where the web view has speech (iOS; Android's
 * WebView has none). Neither app asks for the location, opens pages for Branch or shows its pages, so none is offered.
 * iOS can additionally capture its foreground app natively; its local opt-in filters the socket's actual offers.
 */
// iOS handles screen invokes natively, only after local foreground opt-in. It never forwards them to perform().
export const APP_OFFERS = { ios: ["camera", "listen", "speak", "screen"], android: ["camera", "listen"] };
/** What this phone offers Branch: what it can do, less what the owner told it here never to do. */
export const offersLess = (never, can = PHONE_OFFERS) => can.filter((capability) => !readNever(never).includes(capability));

const text = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
/** The same for a picture or a recording: in pieces, since one spread of megabytes overflows the stack. */
const b64Large = (bytes) => {
  const all = new Uint8Array(bytes);
  let out = "";
  for (let at = 0; at < all.length; at += 0x8000) out += String.fromCharCode(...all.subarray(at, at + 0x8000));
  return btoa(out);
};
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
  const { requestId } = await post("/api/devices/pair", { offer, code, name, platform: env.platform, publicKey: key.publicKey, offers: offersLess(never, env.offers) });
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

/** Cancels an outstanding browser operation even when its promise never settles. */
function cancellable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("Lending stopped."));
    if (signal.aborted) { void Promise.resolve(promise).catch(() => undefined); return stop(); }
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function capture(env, capability, args) {
  const signal = env.signal;
  const pending = env.media.getUserMedia(capability === "camera"
    ? { video: { facingMode: args.facing === "front" ? "user" : "environment" } } : { audio: true });
  const stopTracks = (stream) => stream.getTracks().forEach((track) => track.stop());
  // Permission can finish after stopping: a late stream must never stay open.
  void pending.then((stream) => { if (signal?.aborted) stopTracks(stream); }, () => undefined);
  const stream = await cancellable(pending, signal);
  const stop = () => stopTracks(stream);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) throw new Error("Lending stopped.");
    if (capability === "camera") {
      return { mime: "image/jpeg", name: "camera.jpg", data: await cancellable(env.frame(stream, signal), signal) };
    }
    // PH-03: the recording's own kind (iOS records audio/mp4, others audio/webm), with any codec detail taken off.
    const seconds = Number(args.seconds ?? 5);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Give a recording length between 0 and 30 seconds.");
    const made = await cancellable(env.record(stream, Math.min(30, seconds) * 1000, signal), signal);
    const data = made?.data ?? made, mime = String(made?.mime ?? "audio/webm").split(";")[0].trim().toLowerCase();
    const kind = /^audio\/[a-z0-9.+-]{1,60}$/.test(mime) ? mime : "audio/webm";
    return { mime: kind, name: `listen.${kind === "audio/mp4" ? "m4a" : kind.slice(6)}`, data };
  } finally { signal?.removeEventListener("abort", stop); stop(); }
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
  // PH-03: "spoken" only once the phone said it started; a speaker that never starts is an error, not a success.
  if (capability === "speak") { await cancellable(env.speak(String(args.text ?? "").slice(0, 2000), env.signal), env.signal); return { value: { done: "spoken" } }; }
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
 * One invoke from Branch, checked and done: the answer to send back (a `result`, and the picture or sound's bytes when
 * there are any), or null for an invoke to ignore (a malformed or repeated id). Arguments and switches are checked here
 * whatever Branch or the native side already checked: the phone's own "never", what is switched on, what this phone
 * offers, and the deadline.
 */
export async function answerInvoke(env, lent, frame) {
  const refuse = (error) => ({ result: { type: "result", id: frame.id, ok: false, error } });
  if (!hexOk(frame?.id, 32) || lent.seen.has(frame.id)) return null;
  lent.seen.add(frame.id);
  if (lent.seen.size > 500) lent.seen.delete(lent.seen.values().next().value);
  // Looked at again here: Branch switches a capability on by what the platform can do, not by what
  // this phone offered, so a refused one can still arrive. The phone turns it away itself.
  if (lent.never.includes(frame.capability)) return refuse("This phone never allows that.");
  if (!lent.offers.includes(frame.capability) || !lent.enabled.has(frame.capability)) return refuse("That is switched off on this phone.");
  if (!Number.isFinite(frame.deadline) || frame.deadline < env.now()) return refuse("The request came too late.");
  try {
    const result = await perform(env, frame.capability, frame.args ?? {});
    if (env.signal?.aborted || frame.deadline < env.now() || !lent.enabled.has(frame.capability)) return refuse("Lending stopped or the request expired.");
    if (!result.media) return { result: { type: "result", id: frame.id, ok: true, value: result.value } };
    const bytes = new Uint8Array(result.media.data);
    if (bytes.length > MEDIA_LIMIT) return refuse("The picture or sound was larger than Branch accepts.");
    return { result: { type: "result", id: frame.id, ok: true, value: result.value, media: { mime: result.media.mime, bytes: bytes.length, name: result.media.name } }, bytes };
  } catch (error) {
    return refuse(String(error?.message ?? error).slice(0, 500));
  }
}

/**
 * PH-03: lending from the phone app. The native side (BranchLend) holds the socket and the key: it dials only the
 * Branch this phone was paired with, proves the phone over the challenge itself, and hands the page each invoke while
 * the app's own page is showing. The page does the one thing and gives the answer back. `bridge` is the native plugin
 * (lendStart, lendStop, lendResult, and its "lendState" and "lendInvoke" events), or a stand-in in the tests.
 * Returns a function that stops listening.
 */
export async function serveLending(env, bridge, onState = () => undefined) {
  const status = await bridge.deviceStatus();
  const never = readNever(status?.never), lent = { never, offers: offersLess(never, env.offers ?? APP_OFFERS[env.platform] ?? []), enabled: new Set(), seen: new Set() };
  const active = new Map();
  let stopped = false, generation;
  const cancel = () => { for (const request of active.values()) request.controller.abort(); env.stopOutput?.(); };
  const hidden = env.onHidden?.(() => { lent.enabled.clear(); cancel(); });
  const handles = [
    await bridge.addListener("lendState", (state) => {
      if (Number.isSafeInteger(state?.generation)) {
        if (generation !== undefined && state.generation < generation) return;
        if (generation !== state.generation) cancel();
        generation = state.generation;
      } else if (generation !== undefined) return;
      lent.enabled = new Set(state?.connected && !stopped ? (state.enabled ?? []).filter((c) => lent.offers.includes(c)) : []);
      if (!state?.connected || !lent.enabled.has("speak")) env.stopOutput?.();
      for (const request of active.values()) if (!lent.enabled.has(request.capability)) request.controller.abort();
      onState({ connected: Boolean(state?.connected), enabled: [...lent.enabled], screenOptIn: state?.screenOptIn === true });
    }),
    await bridge.addListener("lendInvoke", async (frame) => {
      if (stopped || !hexOk(frame?.id, 32) || lent.seen.has(frame.id)) return;
      if (generation !== undefined && frame.generation !== generation) return;
      const tag = generation === undefined ? {} : { generation };
      if (active.size) {
        lent.seen.add(frame.id);
        if (lent.seen.size > 500) lent.seen.delete(lent.seen.values().next().value);
        await bridge.lendResult({ type: "result", ...tag, id: frame.id, ok: false, error: "This phone is already answering a request." }).catch(() => undefined);
        return;
      }
      const controller = new AbortController(), request = { controller, capability: frame.capability };
      active.set(frame.id, request);
      const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(2_147_483_647, frame.deadline - env.now())));
      try {
        const answer = await answerInvoke({ ...env, signal: controller.signal }, lent, frame);
        if (!answer || stopped || controller.signal.aborted || (tag.generation !== undefined && tag.generation !== generation)) return;
        const { result, bytes } = answer;
        await bridge.lendResult({ ...result, ...tag, ...(bytes ? { media: { ...result.media, data: b64Large(bytes) } } : {}) });
      } catch { /* The native connection may already have discarded this request. */ }
      finally { clearTimeout(timer); active.delete(frame.id); }
    }),
  ];
  if (status?.paired) await bridge.lendStart();
  return async () => {
    stopped = true;
    lent.enabled.clear();
    cancel();
    hidden?.();
    await bridge.lendStop();
    for (const handle of handles) await handle?.remove?.();
  };
}

/**
 * Stays connected while the app is open; dials again with a growing wait when the line drops.
 * Returns a function that stops it.
 */
export function connectPhone(env, device, key, onState = () => undefined) {
  let stopped = false, attempt = 0, socket = null;
  const never = readNever(device.never), offers = offersLess(device.never, env.offers);
  const lent = { never, offers, enabled: new Set(), seen: new Set() };
  const dial = () => {
    if (stopped) return;
    const address = new URL("/api/devices/socket", device.hub);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    address.searchParams.set("device", device.id);
    socket = new env.WebSocket(address.href);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => void onMessage(JSON.parse(event.data));
    socket.onclose = () => {
      lent.enabled = new Set();
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
      lent.enabled = new Set((frame.enabled ?? []).filter((c) => offers.includes(c)));
      onState({ connected: true, enabled: [...lent.enabled] });
    } else if (frame.type === "invoke") {
      await invoke(frame);
    } else if (frame.type === "bye" && /taken off/.test(String(frame.reason))) {
      stopped = true;
      await env.store.set("device", null);
    }
  }
  async function invoke(frame) {
    const answer = await answerInvoke(env, lent, frame);
    if (!answer) return;
    reply(answer.result);
    if (!answer.bytes) return;
    const framed = new Uint8Array(32 + answer.bytes.length);
    framed.set(text.encode(frame.id), 0);
    framed.set(answer.bytes, 32);
    socket.send(framed);
  }
  dial();
  return () => { stopped = true; socket?.close(); };
}
