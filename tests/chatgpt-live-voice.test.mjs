// A ChatGPT live conversation: only an audio-only offer is sent, and the live session is only
// opened through the pool for the owner, outside a Trunk, while live voice is allowed.
// Nothing here opens a microphone or reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { audioOnlySdp } from "../dist/realtime-chatgpt.js";
import { pooled } from "../dist/accounts/pool-provider.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { primaryAccount } from "../dist/accounts/settings.js";

test("only a single audio offer is admitted, and a remote answer may not point at a private address", () => {
  const audio = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:1 1 udp 1 203.0.113.9 5000 typ host";
  assert.doesNotThrow(() => audioOnlySdp(audio));
  assert.doesNotThrow(() => audioOnlySdp(`${audio}\r\nm=application 0 UDP/DTLS/SCTP webrtc-datachannel`));
  assert.throws(() => audioOnlySdp(`${audio}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96`));
  assert.throws(() => audioOnlySdp("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel"));
  assert.throws(() => audioOnlySdp("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:1 1 udp 1 192.168.1.4 5000 typ host", true));
});

function liveProvider(allowed) {
  const opened = [];
  const original = {
    realtimeTransport: "chatgpt-webrtc",
    complete: async () => { throw new Error("not used"); },
    realtime: async () => { const session = { closed: false, close() { this.closed = true; } }; opened.push(session); return session; },
  };
  const hooks = {
    owner: "local", pool: "chatgpt", model: "gpt", settings: () => null, states: new Map(), cursor: { value: 0 },
    providerFor: async () => null, capReached: () => false, record: () => undefined,
    personIsNotOwner: () => false, realtimeAllowed: () => allowed.value, realtimePrimaryOnly: true,
    sessionChoice: () => null, rememberChoice: () => undefined, now: () => Date.now(),
  };
  return { provider: pooled(original, hooks, true), opened };
}

test("the live session opens through the pool only for the owner's own call while live voice is allowed", async () => {
  const allowed = { value: true };
  const { provider, opened } = liveProvider(allowed);
  const call = { owner: "local", sessionId: "s1", runId: "r1" };
  const session = await withAccountCall(call, () => provider.realtime({}, {}, "v=0", "r1", new AbortController().signal));
  assert.deepEqual({ ...session.consultationAccountRef }, { pool: "chatgpt", account: primaryAccount });
  assert.equal(opened.length, 1);

  await assert.rejects(provider.realtime({}, {}, "v=0", "r1", new AbortController().signal), /unavailable/, "outside a call");
  await assert.rejects(withAccountCall({ ...call, trunk: { keys: { copyFromOwner: true, accounts: {} } } },
    () => provider.realtime({}, {}, "v=0", "r1", new AbortController().signal)), /unavailable/, "a Trunk's call");
  allowed.value = false;
  await assert.rejects(withAccountCall(call, () => provider.realtime({}, {}, "v=0", "r1", new AbortController().signal)),
    /unavailable/, "while locked or another profile is showing");
  assert.equal(opened.length, 1, "no refused call opened a session");
});
