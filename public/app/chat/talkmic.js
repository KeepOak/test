/* Talk live's microphone reader: the small program that runs beside the sound card and hands each block of sound back to
   chat/talklive.js. A served file, not a blob, because the engine's policy lets scripts load only from the window itself. */
class BranchMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("branch-mic", BranchMic);
