import type { Store } from "../store.js";
import type { ChannelRouter } from "./router.js";
import { PARITY_KINDS } from "./parity-kinds.js";
import { paritySummary } from "./parity-config.js";
import { saveParitySwitches, SwitchedChannel } from "./parity-switch.js";

/**
 * `GET /api/channels/parity` lists the added chat services with their switches, and
 * `POST /api/channels/parity { "irc": "on" }` moves some of them. A channel that is already
 * connected follows the new position at once: switching on opens it, switching off closes it.
 */
export async function parityApi(store: Store, owner: string, router: ChannelRouter, method: string, body: unknown) {
  if (method === "POST") {
    const saved = saveParitySwitches(store, owner, body, [...PARITY_KINDS]);
    await Promise.allSettled(router.summary().channels.map(async ({ id }) => {
      const adapter = router.adapter(id);
      if (adapter instanceof SwitchedChannel && adapter.kind in saved) await adapter.refresh();
    }));
  } else if (method !== "GET") throw new Error("Only GET and POST are understood here");
  return { services: await paritySummary(store, owner) };
}
