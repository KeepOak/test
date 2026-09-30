import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { SetupRefusal } from "./check.js";
import { bridgeLink, removeSetup, saveSetup, saveSetupMode, setupList, setupPanel, type SetupHost } from "./service.js";

/**
 * The Set up panel's routes. All four are the owner's alone (a short-lived key is refused before it
 * gets here, which is a separate rule about scripts rather than about who is signed in).
 *
 *   GET  /api/channel-setup              the switch and the list of apps
 *   POST /api/channel-setup              {"mode": "off" | "when-needed" | "on"}
 *   GET  /api/channel-setup/<id>         one app's panel: the command, the links, the square codes
 *   POST /api/channel-setup/<id>/check   {"values": {...}, "enable": "on"}: check, save, switch on if asked, connect now
 *   DELETE /api/channel-setup/<id>       disconnect an app set up here and forget its settings (its secrets stay)
 */
export const handlesChannelSetupPath = (path: string): boolean => path === "/api/channel-setup" || path.startsWith("/api/channel-setup/");

const CheckBodySchema = z.object({
  values: z.record(z.string().max(40), z.string().max(4000)).refine((values) => Object.keys(values).length <= 12, "Too many values"),
  enable: FeatureModeSchema.optional(),
}).strict();

export interface ChannelSetupDeps extends SetupHost {
  requireOwner: (what: string) => void;
}

export async function channelSetupApi(deps: ChannelSetupDeps, method: string, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  // mac7/channels-owner: this is the Set up panel for the owner's chat apps, so all of it is
  // theirs, reads included. A panel says which apps the owner has set up and when, and the switch
  // says whether guided setup is on at all — both are about the owner's chats, which nobody else
  // sharing this computer has any business reading. Asking once here means an address added to
  // the panel later is the owner's without anybody having to remember.
  deps.requireOwner("Setting up chat apps");
  if (path === "/api/channel-setup") {
    if (method === "GET") return setupList(deps.store, deps.owner, deps.platform ?? process.platform);
    if (method !== "POST") throw new SetupRefusal(405, "Use GET or POST here.");
    saveSetupMode(deps.store, deps.owner, await readBody());
    return setupList(deps.store, deps.owner, deps.platform ?? process.platform);
  }
  const check = /^\/api\/channel-setup\/([a-z][a-z0-9-]{0,29})\/check$/.exec(path);
  if (check) {
    if (method !== "POST") throw new SetupRefusal(405, "Use POST here.");
    const body = CheckBodySchema.safeParse(await readBody());
    if (!body.success) throw new SetupRefusal(400, "Send the pasted values, and optionally how to switch the app on.");
    return saveSetup(deps, check[1]!, { values: body.data.values, enable: body.data.enable });
  }
  const link = /^\/api\/channel-setup\/([a-z][a-z0-9-]{0,29})\/link$/.exec(path);
  if (link) {
    if (method !== "POST") throw new SetupRefusal(405, "Use POST here.");
    return bridgeLink(deps, link[1]!);
  }
  const panel = /^\/api\/channel-setup\/([a-z][a-z0-9-]{0,29})$/.exec(path);
  if (panel && method === "GET") return setupPanel(deps.store, deps.owner, panel[1]!, deps.platform ?? process.platform);
  if (panel && method === "DELETE") return removeSetup(deps, panel[1]!);
  throw new SetupRefusal(404, "Not found");
}
