import { api } from "../core/api.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { E } from "../core/state.js";

let enabled = null;
export async function loadPracticeRuns() {
  try { enabled = (await api("practice-runs")).enabled === true; }
  catch (error) { enabled = null; toast(error.message); }
}
export const practiceAttrs = () => `${enabled ? "checked" : ""} ${enabled === null || E.profiles?.isOwner === false ? "disabled" : ""}`;
export function initPracticeRuns(reload) {
  markLive(["sw:f15-practice-runs"]);
  document.addEventListener("change", async (event) => {
    if (event.target?.id !== "f15-practice-runs") return;
    event.target.disabled = true;
    try { enabled = (await api("practice-runs", { enabled: event.target.checked })).enabled; }
    catch (error) { toast(error.message); }
    await reload();
  });
}
