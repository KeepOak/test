import { createRequire } from "node:module";
import { makeTailscaleStatus } from "../remote/tailscale.js";
import { openMdnsSocket } from "./dns-sd.js";
import { makeProbeHello, makeSendOffer, nodePort } from "./hello.js";
import type { DeviceNetwork } from "./index.js";

/**
 * find-computers: the real network parts, for `branch start` alone (src/cli.ts). Tailscale is asked through the one
 * safe runner (fixed arguments, hidden, a time limit); the node door opens on the Tailscale address while Branch runs;
 * the local network is used only while Pair another computer is open (asking) or while waiting to be found
 * (advertising). A Branch made anywhere else, every test included, gets none of this.
 */
export function realDeviceNetwork(env: NodeJS.ProcessEnv = process.env): DeviceNetwork {
  return {
    status: makeTailscaleStatus(),
    probe: makeProbeHello(),
    send: makeSendOffer(),
    openMdns: openMdnsSocket,
    port: nodePort(env),
    version: String(createRequire(import.meta.url)("../../package.json").version),
    presence: true,
  };
}
