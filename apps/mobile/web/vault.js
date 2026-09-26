/**
 * The page's way to the phone's secure storage (iOS Keychain, Android Keystore). The key a paired
 * Branch hands over never reaches this page (the phone app's own): the native side makes the
 * pairing request, keeps what comes back, and adds it to every request itself. What the page can see is only whether a Branch is
 * paired and at which address. `plugin` is the native BranchPhone plugin, or a fake in the tests.
 */
import { checkAddress, pairingBody, readSwitches, refusal, sixDigits } from "./rules.js";

const FIELDS = ["origin", "deviceId", "pairedAt"];
const QUERY = /^[A-Za-z0-9=&._-]*$/;

/**
 * What the pairing call sends. The window's "Pair a phone" square (/devices/pair?offer=…) is answered the way a
 * device answers it (the native phonePair), and the owner's yes beside the check code hands the phone its key (it asks
 * POST /api/devices/pair/session once, after the request is approved). The older "reach Branch from my phone"
 * invitation (/pair?id=…) still pairs through POST /api/pair.
 */
function pairingCall(invitation, code, name) {
  const origin = checkAddress(invitation.origin);
  if (invitation.offer) {
    if (!/^[a-f0-9]{32}$/.test(invitation.offer)) throw refusal("phone.error.damaged", "That invitation link is damaged. Show the square code again.");
    const label = String(name ?? "").trim().slice(0, 80);
    return { origin, offer: invitation.offer, code: sixDigits(code), name: label };
  }
  return { origin, ...pairingBody(invitation.offerId, code, name) };
}

export function createVault(plugin) {
  if (!plugin) throw refusal("phone.notInApp", "This page only works inside the Branch phone app.");
  return {
    /** Pairs through the native side, which keeps the key. Answers the paired address. */
    async pair(invitation, code, name) {
      const call = pairingCall(invitation, code, name);
      // A Devices square is answered by the native phonePair (it asks to be let in, then collects the session once).
      const result = await (call.offer ? plugin.phonePair(call) : plugin.pair(call));
      if (!result?.paired) throw result?.error ? new Error(result.error) : refusal("phone.error.pairFailed", "That did not work. Make a new invitation on the computer.");
      return call.origin;
    },
    /** What the page may know: the address and when it was paired, never the key. */
    async current() {
      const saved = (await plugin.session()) ?? {};
      if (!saved.paired) return null;
      const out = {};
      for (const field of FIELDS) if (typeof saved[field] === "string") out[field] = saved[field];
      if (!out.origin) return null;
      checkAddress(out.origin);
      return out;
    },
    forget: () => plugin.forget(),
    /**
     * A request to the paired Branch; the native side adds the key and refuses other addresses.
     * `extra` is { query } for a read with a query string, or { base64, contentType, query } for bytes that are not JSON.
     */
    async request(method, path, body, extra) {
      if (!/^\/api\/[a-z0-9/_-]+$/i.test(path)) throw refusal("phone.error.request", "Only Branch's own requests can be sent.");
      if (extra?.query !== undefined && !QUERY.test(extra.query)) throw refusal("phone.error.request", "Only Branch's own requests can be sent.");
      const answer = await plugin.request({ method, path, body: body === undefined ? null : body, ...(extra ?? {}) });
      if (answer.status >= 400) throw new Error(answer.data?.error || `Branch answered ${answer.status}.`);
      return answer.data;
    },
    async switches() { return readSwitches((await plugin.getSwitches())?.switches); },
    async setSwitch(name, position) {
      const next = readSwitches({ ...(await this.switches()), [name]: position });
      await plugin.setSwitches({ switches: next });
      return next;
    },
  };
}
