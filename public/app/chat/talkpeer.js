/* Browser media for the ChatGPT subscription offer. Account credentials stay in the engine.
   Called only after the person presses Talk live and the authenticated route permits it. */
async function gathered(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); };
    const changed = () => { if (peer.iceGatheringState === "complete") { done(); resolve(); } };
    const timer = setTimeout(() => { done(); reject(new Error("The live media offer did not finish.")); }, 8000);
    peer.addEventListener("icegatheringstatechange", changed);
    changed();
  });
}

export async function openPeer({ current, desktop, muted, speaking, failed }) {
  if (desktop) await window.branchDesktop?.talkLiveMic?.();
  if (!current()) return null;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  const stopTracks = () => stream.getTracks().forEach(track => track.stop());
  if (!current()) { stopTracks(); return null; }
  let peer;
  try { peer = new RTCPeerConnection({ iceServers: [] }); } catch (error) { stopTracks(); throw error; }
  const player = new Audio();
  player.autoplay = true;
  const close = () => { stopTracks(); player.pause(); player.srcObject = null; peer.close(); };
  try {
    for (const track of stream.getAudioTracks()) { track.enabled = !muted(); peer.addTrack(track, stream); }
    peer.ontrack = event => {
      if (!current()) { close(); return; }
      player.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void player.play().then(() => { if (current()) speaking(); }).catch(() => { if (current()) failed("The live voice could not play sound."); });
    };
    peer.onconnectionstatechange = () => {
      if (current() && ["failed", "disconnected"].includes(peer.connectionState)) failed("The live media connection ended.");
    };
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer);
    if (!current()) { close(); return null; }
    return {
      offer: peer.localDescription?.sdp ?? "",
      answer: sdp => peer.setRemoteDescription({ type: "answer", sdp }),
      mute: value => stream.getAudioTracks().forEach(track => { track.enabled = !value; }),
      close,
    };
  } catch (error) { close(); throw error; }
}
