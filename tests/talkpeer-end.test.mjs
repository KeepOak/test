/* Talk live over a ChatGPT sign-in: End (or the App lock closing the socket) while the browser is still setting up the
   microphone and the peer stops the capture at once. Stand-in browser objects only: no microphone, no network. */
import test from "node:test";
import assert from "node:assert/strict";

function fakeBrowser() {
  const tracks = [], peers = [];
  let grant = null;
  globalThis.window = {};
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } } });
  globalThis.Audio = class { pause() {} };
  globalThis.RTCPeerConnection = class {
    constructor() { this.iceGatheringState = "gathering"; this.closed = false; this.listeners = []; peers.push(this); }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "v=0" }; }
    async setLocalDescription() {}
    addEventListener(_name, fn) { this.listeners.push(fn); }
    removeEventListener() {}
    close() { this.closed = true; }
  };
  const stream = () => {
    const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  return { tracks, peers, allow: () => grant(stream()) };
}
const until = async (check) => { for (let i = 0; i < 500 && !check(); i++) await new Promise((done) => setTimeout(done, 5)); };

test("End while the microphone permission is pending stops the capture as soon as it arrives", async () => {
  const browser = fakeBrowser();
  const { openPeer } = await import(`../public/app/chat/talkpeer.js?pending=${Date.now()}`);
  let end = null;
  const opening = openPeer({ current: () => true, muted: () => false, speaking() {}, failed() {}, own: (close) => { end = close; } });
  assert.equal(typeof end, "function", "the capture is owned before the microphone is asked for");
  end();
  browser.allow();
  assert.equal(await opening, null);
  assert.deepEqual(browser.tracks.map((track) => track.stopped), [true], "the microphone is released");
  assert.equal(browser.peers.length, 0, "no peer is made after End");
});

test("End during the offer's gathering stops the tracks and the peer without waiting out the gather limit", async () => {
  const browser = fakeBrowser();
  const { openPeer } = await import(`../public/app/chat/talkpeer.js?gather=${Date.now()}`);
  let end = null;
  const started = Date.now();
  const opening = openPeer({ current: () => true, muted: () => false, speaking() {}, failed() {}, own: (close) => { end = close; } });
  browser.allow();
  await until(() => browser.peers.length === 1);
  end();
  assert.equal(await opening, null);
  assert.ok(Date.now() - started < 4000, "it did not wait for the eight-second gather limit");
  assert.deepEqual(browser.tracks.map((track) => track.stopped), [true]);
  assert.equal(browser.peers[0].closed, true);
});
