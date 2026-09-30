import { api, token } from "../core/api.js";
import { E } from "../core/state.js";
import { esc, render } from "../core/dom.js";
import { markLive } from "../core/features.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
let targets = [], controller = null, message = "Off until you choose a target", picture = "", initialized = false;
export function nativeWindowViewerSection() {
  if (E.profiles?.isOwner === false) return "";
  return `<section class="sec" id="native-window-viewer"><h2>Watch one native window here</h2><p>Owner app only. No phone, model, task controls or saved pictures. Mac can exclude exact discovered windows from a display at the OS filter. Linux X11 captures one window; arbitrary display exclusions remain unsupported. Wayland uses a WINDOW-only portal picker, not a desktop crop.</p>
    <button class="btn ghost" data-act="native-window-targets">Discover Mac/X11 targets</button>
    <label>Exact discovered target<select id="native-window-target">${targets.map((target, i) => `<option value="${i}">${esc(target.kind === "window" ? `${target.window.title} (${target.window.id}, pid ${target.window.pid})` : `Display ${target.display.id}`)}</option>`).join("")}</select></label>
    <label>Mac display exclusion IDs, comma separated<input id="native-window-excludes" placeholder="IDs from discovery only"></label>
    <button class="btn" data-act="native-window-watch">Watch this exact target for 10 frames</button>
    <label><input type="checkbox" id="native-window-portal-consent">I will select a non-secret window without passwords/sign-in data in the OS picker. Portal identity is opaque: Branch cannot inspect its title/PID or prove an exact native ID match. No automatic Branch-viewer exclusion.</label>
    <button class="btn" data-act="native-window-portal">Choose a Linux portal window and watch 10 frames</button><button class="btn ghost" data-act="native-window-stop">Stop and clear picture</button>
    <p id="native-window-message">${esc(message)}</p><img id="native-window-picture" alt="Owner-selected native window" ${picture ? `src="${picture}"` : ""} style="max-width:100%;${picture ? "" : "display:none"}">
    <p>Requires owner-prepared, hash-pinned helpers. Missing helpers or unsupported portal/compositor contracts hold. Each watch expires; choose again explicitly.</p></section>`;
}
export function initNativeWindowViewer() {
  if (initialized) return; initialized = true;
  markLive(["native-window-targets", "native-window-watch", "native-window-portal", "native-window-stop", "sw:native-window-target", "sw:native-window-excludes", "sw:native-window-portal-consent"]);
  on("native-window-targets", async () => { try { const listed = await api("panels/native-window/targets"); targets = [...listed.windows.map((window) => ({ kind: "window", window })), ...listed.displays.map((display) => ({ kind: "display", display }))]; message = `${targets.length} exact native targets. Exclusion IDs: ${listed.windows.map((window) => window.id).join(", ")}`; render(); } catch (error) { toast(error.message); } });
  on("native-window-watch", () => { try { const target = targets[Number(document.getElementById("native-window-target")?.value)]; if (!target) throw new Error("Discover and choose an exact native target first.");
    const ids = document.getElementById("native-window-excludes").value.split(",").map((id) => id.trim()).filter(Boolean);
    const exclude = ids.map((id) => { const window = targets.find((entry) => entry.kind === "window" && entry.window.id === id)?.window; if (!window) throw new Error("Every excluded ID must be freshly discovered."); return window; });
    void watch({ source: "native", target, exclude, frames: 10, intervalMs: 1000 }); } catch (error) { toast(error.message); } });
  on("native-window-portal", () => { if (!document.getElementById("native-window-portal-consent")?.checked) { toast("Confirm non-secret owner window selection first."); return; } void watch({ source: "portal", ownerWindowConsent: true, frames: 10, intervalMs: 1000 }); });
  on("native-window-stop", stop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
}
function stop() { controller?.abort(); controller = null; picture = ""; message = "Stopped"; update(); }
function update() { const text = document.getElementById("native-window-message"), image = document.getElementById("native-window-picture"); if (text) text.textContent = message; if (image) { if (picture) image.src = picture; else image.removeAttribute("src"); image.style.display = picture ? "" : "none"; } }
async function watch(terms) {
  stop(); const active = new AbortController(); controller = active;
  const observer = new MutationObserver(() => { if (!document.getElementById("native-window-viewer")) active.abort(); }); observer.observe(document.body, { childList: true, subtree: true });
  message = terms.source === "portal" ? "Choose one non-secret window in the OS portal" : "Watching the exact native target"; update();
  try {
    const response = await fetch("/api/panels/native-window/watch", { method: "POST", headers: { "Content-Type": "application/json", "x-branch-origin": "window", ...(token.get() ? { Authorization: `Bearer ${token.get()}` } : {}) }, body: JSON.stringify(terms), signal: active.signal });
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "", finished = false;
    while (true) { const { done, value } = await reader.read(); if (done) break; if (controller !== active) throw new Error("Viewer was replaced."); pending += decoder.decode(value, { stream: true }); if (pending.length > 28_000_000) throw new Error("Viewer line bound exceeded.");
      let newline; while ((newline = pending.indexOf("\n")) >= 0) { const event = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        if (event.kind === "frame") { picture = "data:image/png;base64," + event.png; message = "Owner-selected source frame"; }
        else if (event.kind === "grant") message = event.grant ? `Portal WINDOW grant, serial ${event.grant.serial}; opaque ID ${event.grant.opaqueId || "unavailable"}` : "Exact native capture terms selected";
        else if (event.kind === "error") throw new Error(event.message); else if (event.kind === "end") { finished = true; message = "Bounded watch finished; choose again to resume"; }
        update(); }
    }
    if (!finished || pending.trim()) throw new Error("Viewer ended without its bounded receipt.");
  } catch (error) { if (controller !== active) return; if (!active.signal.aborted) { message = error.message; toast(message); } picture = ""; update(); }
  finally { active.abort(); observer.disconnect(); if (controller === active) controller = null; }
}