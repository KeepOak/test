import { pinnedSkillKey } from "../skill-tools.js";
import type { Call, Reply } from "./handlers.js";

/**
 * CHAT-192 and CHAT-205: two commands the other assistants have, in the one command table.
 *
 * `/steer <words>` hands a note to the task working in this conversation, which reads it before its next step: the same
 * path as the window's Steer box (POST /api/runs/<id>/steer). Typed in a chat app while a task works, the router passes
 * it on exactly as a message typed while it works (named as its sender's, never as the owner); with nothing working
 * there, this says so.
 *
 * `/skill <name>` pins one of the installed, switched-on skills to this conversation, so its instructions apply to every
 * turn (the window's skill pin, `pinned-skill:<conversation>`); `/skill off` unpins it; `/skill` on its own says which
 * is pinned. A skill's instructions stay guidance under the task and its permissions: pinning one grants nothing.
 */
const say = (text: string): Reply => ({ text });

export function steer(call: Call): Reply {
  const words = call.argument.trim();
  if (!words) return say("Send /steer and the note, for example /steer use the newer figures.");
  if (words.length > 2000) return say("A note can be at most 2000 characters.");
  if (!call.sessionId) return say("Nothing is working in this conversation right now.");
  const { runtime } = call.host;
  const run = runtime.store.runs(runtime.owner).find((one) => one.sessionId === call.sessionId && one.status === "running");
  if (!run) return say("Nothing is working in this conversation right now; send it as an ordinary message instead.");
  const { queued } = runtime.steer(run.id, words);
  return say(`Passed on${queued > 1 ? ` (${queued} notes waiting)` : ""}. It reads it before its next step; if it is already writing its answer, send it again afterwards.`);
}

export function skill(call: Call): Reply {
  const { store, owner } = call.host.runtime;
  if (!call.sessionId) return say("Start a conversation first; a skill is pinned to the conversation you are in.");
  const key = pinnedSkillKey(call.sessionId);
  const installed = store.skills.catalog(owner);
  const word = call.argument.trim();
  const pinnedId = (store.get("settings", owner, key)?.data as { skillId?: string } | undefined)?.skillId;
  if (!word) {
    const pinned = installed.find((one) => one.id === pinnedId);
    if (pinned) return say(`${pinned.name} is pinned here: its instructions apply to every turn. /skill off unpins it.`);
    return say(installed.length ? `No skill is pinned here. Send /skill and one of: ${installed.map((one) => one.name).sort().join(", ")}.`
      : "No skills are switched on. Add one under Customize › Skills.");
  }
  if (word.toLowerCase() === "off") {
    if (!pinnedId) return say("No skill is pinned here.");
    store.delete("settings", owner, `pinned-skill:${call.sessionId}`);
    return say("Unpinned. No skill applies to every turn here now.");
  }
  const wanted = word.toLowerCase();
  const exact = installed.filter((one) => one.name.toLowerCase() === wanted);
  const found = exact.length ? exact : installed.filter((one) => one.name.toLowerCase().startsWith(wanted));
  if (found.length !== 1)
    return say(found.length ? `More than one skill starts with "${word}": ${found.map((one) => one.name).sort().join(", ")}.`
      : `There is no switched-on skill called "${word}". /skill on its own lists them.`);
  store.save("settings", owner, `pinned-skill:${call.sessionId}`, { skillId: found[0]!.id }); // pinnedSkillKey, written out so the settings scans read it
  return say(`Pinned ${found[0]!.name} to this conversation: its instructions apply to every turn until /skill off.`);
}
