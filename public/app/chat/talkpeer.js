/* Browser media for the ChatGPT subscription offer. Account credentials stay in the engine.
   Called only after the person presses Talk live and the authenticated route permits it. */
async function gathered(peer, quit) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); quit.removeEventListener("abort", stopped); };
    const changed = () => { if (peer.iceGatheringState === "complete") { done(); resolve(); } };
    const stopped = () => { done(); resolve(); }; // ended: the caller sees it is no longer current and lets go
    const timer = setTimeout(() => { done(); reject(new Error("The live media offer did not finish.")); }, 8000);
    peer.addEventListener("icegatheringstatechange", changed);
    quit.addEventListener("abort", stopped, { once: true });
    changed();
  });
}

/**
 * The one slot for the closer of a live setup still in progress. A setup keeps its closer there only while it is still the
 * current call, and letting go afterwards clears the slot only if it still holds that same closer, so a slower, ended call
 * never erases the closer of the call that replaced it. `stop()` closes whatever setup is in the slot.
 */
export function openingSlot() {
  let held = null;
  return {
    own(close, isCurrent) {
      if (!isCurrent()) { close(); return () => {}; }
      held = close;
      return () => { if (held === close) held = null; };
    },
    stop() { const close = held; held = null; close?.(); },
  };
}

/* `own(close)` is called before the microphone is asked for, so End or App lock at any point of the setup (the
   permission prompt, the offer, the eight-second gathering) stops the capture and the peer at once. */
export async function openPeer({ current, desktop, muted, speaking, failed, own = () => {} }) {
  const quit = new AbortController();
  let stream = null, peer = null, player = null;
  const close = () => {
    quit.abort();
    stream?.getTracks().forEach(track => track.stop());
    if (player) { player.pause(); player.srcObject = null; }
    peer?.close();
  };
  own(close);
  const live = () => !quit.signal.aborted && current();
  if (desktop) await window.branchDesktop?.talkLiveMic?.();
  if (!live()) { close(); return null; }
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  if (!live()) { close(); return null; }
  try { peer = new RTCPeerConnection({ iceServers: [] }); } catch (error) { close(); throw error; }
  player = new Audio();
  player.autoplay = true;
  try {
    for (const track of stream.getAudioTracks()) { track.enabled = !muted(); peer.addTrack(track, stream); }
    peer.ontrack = event => {
      if (!live()) { close(); return; }
      player.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void player.play().then(() => { if (live()) speaking(); }).catch(() => { if (live()) failed("The live voice could not play sound."); });
    };
    peer.onconnectionstatechange = () => {
      if (live() && ["failed", "disconnected"].includes(peer.connectionState)) failed("The live media connection ended.");
    };
    const offer = await peer.createOffer();
    if (!live()) { close(); return null; }
    await peer.setLocalDescription(offer);
    if (!live()) { close(); return null; }
    await gathered(peer, quit.signal);
    if (!live()) { close(); return null; }
    return {
      offer: peer.localDescription?.sdp ?? "",
      answer: sdp => peer.setRemoteDescription({ type: "answer", sdp }),
      mute: value => stream.getAudioTracks().forEach(track => { track.enabled = !value; }),
      close,
    };
  } catch (error) { close(); throw error; }
}
