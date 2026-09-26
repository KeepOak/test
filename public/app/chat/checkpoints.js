/* A checkpoint in the thread (prototype block "ckpt"): where a task kept a point to come back to with the
   workspace.checkpoint tool, the conversation shows the point under the reply that kept it, in the engine's own label,
   with Put it all back. The point is a kept snapshot (GET /api/state snapshots), and putting it back is
   POST /api/history/snapshots/<id>/restore, which writes back every file it holds. A point the engine no longer keeps is
   not drawn. */

import { esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

/* Points put back in this window, with how many files the engine wrote back. */
const restored = new Map();

function keptPoint(call, messages) {
  if (call.name !== "workspace.checkpoint") return null;
  const answer = messages.find((x) => x.role === "tool" && x.toolCallId === call.id);
  let said;
  try { said = JSON.parse(answer?.content ?? "null"); } catch { return null; } // a result that is not the tool's JSON has no point in it
  const point = said?.ok ? said.result : null;
  return point?.id && (E.state?.snapshots ?? []).some((s) => s.id === point.id) ? point : null;
}

/* The checkpoints kept by one reply's tool calls, each as its own row under the reply. */
export function checkpointRows(m, messages) {
  return (m.toolCalls ?? []).map((call) => keptPoint(call, messages)).filter(Boolean).map((p) => {
    const back = restored.get(p.id);
    const words = back == null ? p.label : t("window.chat.ckpt.put-back", { count: back });
    const button = back == null ? `<button class="btn sm" type="button" data-act="ckpt" data-id="${esc(p.id)}">${t("window.chat.ckpt.put-all-back")}</button>` : "";
    return `<div class="b"><div class="gut"></div><div><div class="ckpt">${ic("shield", "s")}<span>${esc(words)}</span>${button}</div></div></div>`;
  }).join("");
}

async function putBack(el) {
  const id = el.dataset.id;
  if (!/^[a-f0-9-]{36}$/.test(id ?? "")) return;
  let done;
  try { done = await api(`history/snapshots/${id}/restore`, {}); } catch (error) { toast(error.message); return; }
  restored.set(id, done.restored);
  renderNow();
  /* Undo: the engine kept the files as they were just before (`kept`, a snapshot of its own); putting that back undoes it. */
  const kept = /^[a-f0-9-]{36}$/.test(done.kept ?? "") ? done.kept : null;
  toast(t("window.chat.ckpt.back", { count: done.restored }), kept ? () => undoPutBack(id, kept) : undefined);
}
async function undoPutBack(id, kept) {
  try { await api(`history/snapshots/${kept}/restore`, {}); } catch (error) { toast(error.message); return; }
  restored.delete(id);
  renderNow();
}

export function initCheckpoints() {
  markLive(["ckpt"]);
  on("ckpt", (el) => putBack(el));
}
