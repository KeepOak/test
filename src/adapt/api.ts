import { adaptFor, continuationFor } from "./host.js";
import { adaptMode, saveAdaptSettings } from "./settings.js";
import type { PressContext } from "../local-one-button.js";
import type { Store } from "../store.js";
import { byCard, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * mac7/adapt: the `/api/adapt` family. Looking (GET) describes and changes nothing, and shows the
 * owner's stopped tasks to the owner only; every POST is the owner's own step in the app window,
 * which is why each is "owner POST" in the table of what a short-lived key may reach.
 */
export const handlesAdaptPath = (path: string): boolean => path === "/api/adapt" || path.startsWith("/api/adapt/");

export interface AdaptApiDeps {
  store: Store;
  owner: string;
  requireOwner: (what: string) => void;
}

export async function adaptApi(
  deps: AdaptApiDeps, method: string, path: string, body: () => Promise<unknown>, context: PressContext = {},
): Promise<unknown> {
  const { store, owner } = deps;
  // merge-queue review: the stopped tasks are the owner's work, so somebody else signed in on this
  // computer under their own profile sees the switch and nothing of the owner's tasks.
  if (method === "GET" && path === "/api/adapt") {
    const mine = (() => { try { deps.requireOwner("/adapt"); return true; } catch { return false; } })();
    return { mode: adaptMode(store, owner), stops: mine ? adaptFor(store, owner).stops.waiting() : [] };
  }
  if (method === "POST" && path === "/api/adapt/switch") {
    deps.requireOwner("the /adapt switch");
    const input = await body();
    return recordedWrite(store, owner, byCard("adapt"), ["adapt"], () => saveAdaptSettings(store, owner, input));
  }
  // merge-queue review: writing a stop into the owner's list, and reading an offer for one, are the
  // owner's too; the short-lived-key table already said "owner POST" and now the route agrees.
  if (method === "POST" && path === "/api/adapt/stopped") {
    deps.requireOwner("/adapt");
    return adaptFor(store, owner).record(await body());
  }
  // p17: "Leave it stopped" in Inbox › Needs you. The owner's own step; the stop is kept, only no longer offered.
  if (method === "POST" && path === "/api/adapt/leave") {
    deps.requireOwner("/adapt");
    return adaptFor(store, owner).leave(await body());
  }
  if (method === "POST" && path === "/api/adapt/plan") {
    deps.requireOwner("/adapt");
    return adaptFor(store, owner).look(await body(), context);
  }
  if (method === "POST" && path === "/api/adapt/go") {
    deps.requireOwner("/adapt");
    const answer = await adaptFor(store, owner, { writer: "owner-in-window", source: "card", detail: "adapt" }).go(await body(), context);
    return { ...answer, carryOn: answer.done && answer.stop ? continuationFor(answer.stop, answer.gained) : "" };
  }
  throw new Error("That is not something Branch can do with /adapt");
}
