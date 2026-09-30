import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { esc, render } from "../core/dom.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";

let state = null;
export async function loadContinuousQa() {
  try { state = await api("continuous-qa"); } catch (error) { state = { problem: error.message }; }
  render();
}
export function initContinuousQa() {
  markLive(["qa-save", "qa-refresh", "sw:qa-enabled", "sw:qa-copy", "sw:qa-target", "sw:qa-interval", "sw:qa-cycles", "sw:qa-model", "sw:qa-preset", "sw:qa-tokens", "sw:qa-daily-tokens", "sw:qa-paths", "sw:qa-journey-settings-reading", "sw:qa-journey-usage-reading", "sw:qa-journey-self-reading"]);
  on("qa-refresh", () => loadContinuousQa());
  on("qa-save", async () => {
    const field = (id) => document.getElementById(id);
    try {
      const settings = { ...state?.settings, enabled: field("qa-enabled").checked, copyId: field("qa-copy").value.trim() || null,
        target: field("qa-target").value, journeys: ["settings-reading", "usage-reading", "self-reading"].filter((id) => field("qa-journey-" + id).checked),
        intervalMinutes: Number(field("qa-interval").value), maxCyclesPerDay: Number(field("qa-cycles").value),
        modelFixes: field("qa-model").checked, preset: field("qa-preset").value.trim(),
        fixTokens: Number(field("qa-tokens").value), dailyFixTokens: Number(field("qa-daily-tokens").value),
        fixPaths: field("qa-paths").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
      state = await api("continuous-qa", settings); render();
    } catch (error) { toast(error.message); }
  });
}
export function continuousQaSection() {
  const s = state?.settings ?? {};
  const input = (id, label, value, type = "text") => `<label>${esc(label)}<input id="${id}" type="${type}" value="${esc(value)}"></label>`;
  return `<section class="sec"><h2>Continuous isolated QA</h2>
    <p>Use a prepared Test copy, never your installed app. Fixed navigation clicks only; no editing, deletion, sending, purchases or safety changes.</p>
    <label>Isolated target<select id="qa-target"><option value="web" ${!s.target || s.target === "web" ? "selected" : ""}>Browser app</option><option value="desktop-copy" ${s.target === "desktop-copy" ? "selected" : ""}>Prepared Linux packaged desktop copy</option><option value="native-copy" ${s.target === "native-copy" ? "selected" : ""}>Prepared native Windows Sandbox / macOS sandbox copy</option></select></label>
    <p>Native runs require your explicit read-only journey choices and prepared packaged copy. They never attach your app.</p>
    ${["settings-reading", "usage-reading", "self-reading"].map((id) => `<label><input id="qa-journey-${id}" type="checkbox" ${(s.journeys ?? []).includes(id) ? "checked" : ""}>${esc(id)}</label>`).join("")}
    <label><input id="qa-enabled" type="checkbox" ${s.enabled ? "checked" : ""}>Enable recurring observations</label>
    ${input("qa-copy", "Prepared Test copy ID", s.copyId ?? "")}
    ${input("qa-interval", "Minutes between cycles (30–1440)", s.intervalMinutes ?? 120, "number")}
    ${input("qa-cycles", "Maximum cycles per day (1–12)", s.maxCyclesPerDay ?? 2, "number")}
    <label><input id="qa-model" type="checkbox" ${s.modelFixes ? "checked" : ""}>Allow model use for isolated fix drafts after a failure</label>
    <p>Fix drafts use the selected model and token budget. They need your review; nothing is published or merged.</p>
    ${input("qa-preset", "Fix model preset ID", s.preset ?? "")}
    ${input("qa-tokens", "Token cap per draft", s.fixTokens ?? 10000, "number")}
    ${input("qa-daily-tokens", "Daily draft token cap", s.dailyFixTokens ?? 20000, "number")}
    <label>Existing files a draft may edit, one path per line<textarea id="qa-paths">${esc((s.fixPaths ?? []).join("\n"))}</textarea></label>
    <button class="btn" data-act="qa-save">Save QA choices</button><button class="btn ghost" data-act="qa-refresh">Refresh QA status</button>
    <p>${esc(state?.problem ?? (state?.running ? "Observing the isolated copy" : "Waiting for the next enabled cycle"))}</p>
    <pre>${esc(JSON.stringify(state?.findings ?? {}, null, 2))}</pre></section>`;
}
