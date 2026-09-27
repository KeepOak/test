import { makeTailscaleStatus } from "../remote/tailscale.js";
import { openMdnsSocket } from "./dns-sd.js";
import { makeProbeHello, makeSendOffer, nodePort } from "./hello.js";
import type { DeviceNetwork } from "./index.js";

/**
 * find-computers: the real network parts, for `branch start` (src/cli.ts) and the desktop app (src/desktop/main.ts).
 * Tailscale is asked through the one safe runner (fixed arguments, hidden, a time limit); the node door opens on the
 * Tailscale address only while looking or waiting to be found, and answers only the same Tailscale user's nodes; the
 * local network is used only while Pair another computer is open (asking) or while waiting to be found
 * (advertising). A Branch made anywhere else, every test included, gets none of this.
 */
export function realDeviceNetwork(env: NodeJS.ProcessEnv = process.env): DeviceNetwork {
  return {
    status: makeTailscaleStatus(),
    probe: makeProbeHello(),
    send: makeSendOffer(),
    openMdns: openMdnsSocket,
    port: nodePort(env),
    presence: true,
  };
}
