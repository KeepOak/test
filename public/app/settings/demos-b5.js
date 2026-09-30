/* Pass 17b's rows on the Settings pages ("what the engine already does"), each opening a small dialog of the engine's own
   readout (places/demo17.js demoDlg17), never the prototype's example rows. A dialog lists what the engine returns and
   says "Nothing recorded here." when it has nothing; its primary action, where it has one, is the engine's own.
   Registered once, from Settings' init, so every page's row is live or greyed the moment it is drawn.
   Rows with no handler here stay greyed, each for the reason written beside WHY below. */
import { esc, render } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { closeDlg, toast } from "../core/ui.js";
import { onDemo17, demoDlg17 } from "../places/demo17.js";
import { WORDS } from "./rows17.js";
import { initTelegramDepth } from "./telegram-depth.js";
import { t, language } from "../../i18n.js";

const when = (at) => (at ? new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const title = (key) => WORDS[key][0];
const empty = () => t("inspector.nothing");
const w = (k, vars) => t(`window.settings.demos-b5.${k}`, vars);
const list = (x) => (Array.isArray(x) ? x : []);
const show = (key, lead, rows, extra = {}) => demoDlg17(key, { title: title(key), lead, rows, empty: empty(), ...extra });
const on = (value) => Boolean(value) && value !== "off";

/* ---------- Data & usage ---------- */
function money() {
  /* Prepaid balances: what each connection has left, as the engine reads it (GET /api/usage/glance). */
  onDemo17("balance", { open: async () => {
    const g = await api("usage/glance");
    show("balance", w("left"), list(g.rows).map((r) => [r.connectionName + (r.accountLabel ? ` · ${r.accountLabel}` : ""),
      list(r.windows).map((x) => `${x.title}${x.remaining == null ? "" : ` · ${x.remaining}`}`).join(" · ") || r.note,
      r.state === "measured" ? ["ok", t("glance.measured")] : r.state === "estimated" ? ["warn", t("glance.estimate")] : ["idle", t("glance.notPublished")]]));
  } });
  /* What each project cost: GET /api/projects/costs. */
  onDemo17("projcost", { open: async () => {
    const { projects } = await api("projects/costs");
    show("projcost", "", list(projects).map((p) => [p.name, `${p.display} · ${w("runs", { count: p.runs })}`, ["idle", w("project")]]));
  } });
  /* Backups: the copies kept before each update (GET /api/deployment/restore-points); Back up now is POST /api/deployment/backup. */
  onDemo17("backup", { open: async () => {
    const { points } = await api("deployment/restore-points");
    show("backup", w("kept"), list(points).map((p) => [when(p.savedAt), `${p.version} · ${(p.bytes / 1048576).toFixed(1)} MB`, ["ok", w("done")]]), { go: w("back-up-now") });
  }, go: async () => {
    await api("deployment/backup", {});
    closeDlg();
    toast(w("backed-up"));
  } });
  /* Saved before it's deleted: the engine's own sentence and what is due (GET /api/retention). */
  onDemo17("retention", { open: async () => {
    const r = await api("retention");
    show("retention", r.sentence, list(r.conversations).map((c) => [c.title ?? c.opening ?? c.id, when(c.updatedAt ?? c.at), ["idle", w("due")]]));
  } });
  /* Things held for your yes (GET /api/restore/held); Keep the newer ones keeps this computer's own values for every
     group (POST /api/restore/held { keep }), which changes nothing here and drops what the backup held. */
  onDemo17("held", { open: async () => {
    const { held } = await api("restore/held");
    show("held", "", list(held).map((g) => [g.group, g.ids.join(", "), ["warn", w("held-pill")]]), list(held).length ? { go: w("keep-newer") } : {});
  }, go: async () => {
    const { held } = await api("restore/held");
    await api("restore/held", { keep: list(held).map((g) => g.group) });
    closeDlg();
    toast(w("kept-newer"));
  } });
}

/* ---------- Models ---------- */
function models() {
  /* Private things stay here: the engine's local routing (GET /api/local-models/routing). */
  onDemo17("localroute", { open: async () => {
    const r = await api("local-models/routing");
    show("localroute", w("always-here"), [[w("card-number"), w("caught"), r.enabled && r.localForPrivate ? ["ok", w("here")] : ["idle", t("accounts.switch.off")]]]);
  } });
  /* Sure-or-not checks: the engine's yes-or-no checker and its threshold (GET /api/jev). */
  onDemo17("jev", { open: async () => {
    const j = await api("jev");
    show("jev", "", [[t("jev.field.mode"), j.model || j.provider, on(j.mode) ? ["ok", t("accounts.switch.on")] : ["idle", t("accounts.switch.off")]],
      [t("jev.field.confidence"), `${Math.round(j.minConfidence * 100)}%`, null]]);
  } });
  /* Model services from plugins: GET /api/providers/plugins. */
  onDemo17("provplug", { open: async () => {
    const { providers } = await api("providers/plugins");
    show("provplug", w("installed"), list(providers).map((p) => [p.name, p.description || p.plugin, ["ok", t("accounts.switch.on")]]));
  } });
  /* Programs for sound and video: where the engine found ffmpeg and yt-dlp (GET /api/media/programs). */
  onDemo17("mediapaths", { open: async () => {
    const m = await api("media/programs");
    show("mediapaths", w("found"), [["ffmpeg", m.ffmpeg?.path || m.ffmpeg?.problem || "", m.ffmpeg?.path ? ["ok", w("found-pill")] : ["warn", w("missing")]],
      ["yt-dlp", m.ytDlp?.path || m.ytDlp?.problem || "", m.ytDlp?.path ? ["ok", w("found-pill")] : ["warn", w("missing")]]]);
  } });
  /* Each service's terms: the catalogue's own line for each service (GET /api/providers/catalog presets[].terms). */
  onDemo17("terms", { open: async () => {
    const { presets } = await api("providers/catalog");
    show("terms", w("terms"), list(presets).filter((p) => p.terms).map((p) => [p.displayName, p.terms.route, p.terms.standing === "official" ? ["ok", w("allowed")] : ["warn", p.terms.standing]]));
  } });
}

/* ---------- Permissions ---------- */
function permissions() {
  /* Trusted folders: GET /api/folder-trust. Trusting one more loosens what Trunks may change, so it is not offered here. */
  onDemo17("trust", { open: async () => {
    const f = await api("folder-trust");
    show("trust", w("trusted"), list(f.folders).map((x) => [x.label || x.path, x.path, x.trust === "trusted" ? ["ok", w("trusted-pill")] : x.trust === "never" || x.trust === "refused" ? ["no", w("never")] : ["idle", w("not-yet")]]));
  } });
  /* A practice workspace: what it holds (GET /api/practice). Moving work into it or back out changes where Trunks
     change files, so that stays with the practice switch's own place and is not offered here. */
  onDemo17("practice", { open: async () => {
    const p = await api("practice");
    show("practice", "", list(p.files).map((f) => [f, "", ["idle", w("made-up")]]));
  } });
  /* Keys never land in transcripts: the kinds the leak guard blanks and how strict it is (GET /api/knobs leakGuard). */
  onDemo17("leakguard", { open: async () => {
    const k = await api("knobs");
    const except = new Set(k.values?.leakGuard?.exceptions ?? []);
    show("leakguard", "", list(k.leakKinds).map((kind) => [kind, "", except.has(kind) ? ["no", w("leak")] : ["ok", w("hidden")]]));
  } });
}

/* ---------- Saved sign-ins, Computer & browser ---------- */
function reach() {
  /* Keys Branch holds: the active project's key names and when each was last handed to a command
     (GET /api/secrets/<project>, GET /api/secrets/audit). Never a value. */
  onDemo17("keys", { open: async () => {
    const project = (await api("projects")).active?.id ?? "default";
    const [{ secrets }, { uses }] = await Promise.all([api(`secrets/${encodeURIComponent(project)}`), api("secrets/audit")]);
    const last = (name) => list(uses).find((u) => u.name === name)?.usedAt;
    show("keys", w("keys"), list(secrets).map((s) => [s.name, last(s.name) ? w("last-used", { when: when(last(s.name)) }) : "", s.overdue ? ["warn", w("soon")] : ["ok", w("set")]]));
  } });
  /* Fix and run again: the engine's record of each failed command it tried to fix (GET /api/troubleshoot). */
  onDemo17("troubleshoot", { open: async () => {
    const { records } = await api("troubleshoot");
    show("troubleshoot", "", list(records).map((r) => [r.command, r.line, r.status === "fixed" ? ["ok", w("fixed")] : ["no", w("failed")]]));
  } });
  /* Programs that keep running: GET /api/processes. */
  onDemo17("bgproc", { open: async () => {
    const { processes } = await api("processes");
    show("bgproc", w("running"), list(processes).filter((p) => p.status === "running").map((p) => [p.name || p.program, when(p.startedAt), ["ok", w("running-pill")]]));
  } });
  /* Browser profiles that stay signed in: GET /api/browser/profiles. A Trunk's own (kept with browser.profile "keep",
     named trunk-<its id>) is shown under the Trunk's name; each with when it was last saved. */
  onDemo17("profiles", { open: async () => {
    const { profiles } = await api("browser/profiles");
    const owner = (name) => (Array.isArray(E.trunks) ? E.trunks : []).find((tr) => `trunk-${String(tr.id).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}` === name)?.name;
    show("profiles", w("profiles"), list(profiles).map((p) => [owner(p.name) ?? p.name, when(p.savedAt), ["ok", w("kept")]]));
  } });
}

/* ---------- Branch itself, Updates, People ---------- */
function care() {
  /* Suggestions made on this computer: the habits the engine counted here (GET /api/learning-core). */
  onDemo17("learncore", { open: async () => {
    const l = await api("learning-core");
    show("learncore", w("suggested"), list(l.habits).map((h) => [h.name, w("times", { count: h.uses }), ["idle", h.kind]]));
  } });
  /* If an update fails: the newest update that did not go through (GET /api/updates/failure). */
  onDemo17("updfix", { open: async () => {
    const { failure } = await api("updates/failure");
    show("updfix", "", failure ? [[`${failure.fromVersion} → ${failure.toVersion}`, when(failure.at), ["no", w("failed")]]] : []);
  } });
  /* Signed household records: GET /api/collab/events, each checked against its signature by the engine. */
  onDemo17("signed", { open: async () => {
    const { events } = await api("collab/events");
    show("signed", w("recent"), list(events).map((e) => [e.member, `${e.kind} · ${when(e.at)}`, ["ok", w("signed")]]));
  } });
}

/* ---------- Advanced ---------- */
function advanced() {
  /* Project notes as files: the active project's notes (GET /api/projects/notes). */
  onDemo17("wsmem", { open: async () => {
    const n = await api("projects/notes");
    show("wsmem", n.project, list(n.notes).map((x) => [x.title ?? x.name ?? "", x.body?.slice(0, 80) ?? "", ["idle", w("file")]]));
  } });
  /* Notes it keeps for itself: GET /api/reach/notes. */
  onDemo17("reachnotes", { open: async () => {
    const { notes } = await api("reach/notes");
    show("reachnotes", "", list(notes).map((x) => [x.title, when(x.updatedAt), ["idle", w("note")]]));
  } });
  /* Health: the engine's readouts (GET /api/health). */
  onDemo17("health", { open: async () => {
    const h = await api("health");
    show("health", w("right-now"), list(h.items).map((i) => [i.name, i.summary, i.ok ? ["ok", w("fine")] : ["warn", w("look")]]));
  } });
  /* Errors that say how to fix them: each check that failed, with the engine's own fix (GET /api/health items[].fix). */
  onDemo17("fixhints", { open: async () => {
    const h = await api("health");
    show("fixhints", "", list(h.items).filter((i) => !i.ok && i.fix).map((i) => [i.name, i.fix, ["ok", w("fix")]]));
  } });
}

/* ---------- Developer ---------- */
function developer() {
  /* Build on Branch: the kits the engine ships (GET /api/sdk-kit). */
  onDemo17("sdk", { open: async () => {
    const k = await api("sdk-kit");
    show("sdk", w("available"), Object.entries(k.packages ?? {}).map(([name, p]) => [name, p.install, ["idle", w("kit")]]));
  } });
  /* Keys for scripts and phones: the short-lived keys that exist, by name and scope (GET /api/tokens); never a key.
     Making one hands out a key, which stays for the security review. */
  onDemo17("scopes", { open: async () => {
    const { tokens } = await api("tokens");
    show("scopes", "", list(tokens).map((k) => [k.name, `${k.scope} · ${w("until", { when: when(k.expiresAt) })}`, k.revokedAt ? ["idle", w("revoked")] : ["ok", w("works")]]));
  } });
  /* Send traces elsewhere: the destinations the engine offers (GET /api/tracing/settings); Send a test trace is
     POST /api/tracing/test, which the engine refuses in its own words while sending is off. */
  onDemo17("tracing", { open: async () => {
    const tr = await api("tracing/settings");
    show("tracing", w("destinations"), list(tr.destinations).map((d) => [d.label, d.description, tr.settings?.enabled && tr.settings.destination === d.id ? ["ok", t("accounts.switch.on")] : ["idle", t("accounts.switch.off")]]), { go: w("test-trace") });
  }, go: async () => {
    const sent = await api("tracing/test", {});
    closeDlg();
    toast(sent.ok ? w("test-sent") : sent.error);
  } });
  /* Studies: the last results (GET /api/studies). */
  onDemo17("studies", { open: async () => {
    const s = await api("studies");
    show("studies", "", list(s.results).map((r) => [r.name, `${when(r.startedAt)} · ${w("tasks", { count: r.tasks })}`, r.stoppedEarly ? ["warn", w("stopped")] : ["idle", w("run")]]));
  } });
  /* What went with the last request: the open conversation's room, part by part, as the engine measured it
     (GET /api/sessions/<id>/context: instructions, tools, the conversation and the room left). */
  onDemo17("toolreport", { open: async () => {
    const r = S.chat ? await api(`sessions/${encodeURIComponent(S.chat)}/context`) : null;
    show("toolreport", r ? `${r.model} · ${r.measured}` : "", r ? [[w("part-instructions"), w("tokens", { count: r.instructions }), ["idle", w("kept")]], [w("part-tools"), w("tokens", { count: r.tools }), ["idle", w("kept")]],
      [w("part-conversation"), w("tokens", { count: r.conversation }), ["idle", w("kept")]], [w("part-left"), w("tokens", { count: r.left }), r.left < 0 ? ["warn", w("look")] : ["ok", w("fine")]]] : []);
  } });
  /* Live panels and app blocks: GET /api/asks/surfaces. */
  onDemo17("surfaces", { open: async () => {
    const { surfaces } = await api("asks/surfaces");
    show("surfaces", w("available"), list(surfaces).map((x) => [x.title, x.tool ?? "", ["ok", t("accounts.switch.on")]]));
  } });
  /* Procedures as text: the newest procedure as YAML, checked by the engine (GET /api/flows, /api/flows/<id>/yaml). */
  onDemo17("flowyaml", { open: async () => {
    const { flows } = await api("flows");
    const first = list(flows)[0];
    const yaml = first ? await api(`flows/${encodeURIComponent(first.id)}/yaml`) : null;
    demoDlg17("flowyaml", { title: title("flowyaml"), lead: first?.name ?? "", rows: [], empty: yaml ? "" : empty() });
    if (yaml) document.querySelector(".demo-b17")?.insertAdjacentHTML("beforeend", `<pre class="code6">${esc(yaml.yaml)}</pre>`);
  } });
}

/* ---------- Readouts the engine keeps for rows PR #460 had left without a button ---------- */
const onOff = (value) => (on(value) ? ["ok", t("accounts.switch.on")] : ["idle", t("accounts.switch.off")]);
const changed = (changes) => list(changes).map((c) => c.setting).join(", ");
function guards() {
  /* Loops and empty answers: the loop guard's own switch (GET /api/loop-guard { mode }). */
  onDemo17("loopguard", { open: async () => {
    const { mode } = await api("loop-guard");
    show("loopguard", "", [[title("loopguard"), "", onOff(mode)]]);
  } });
  /* Follow-ups made whole: the switch for rewriting a short follow-up before documents are searched (GET /api/chat-engine). */
  onDemo17("followup", { open: async () => {
    const { mode } = await api("chat-engine");
    show("followup", "", [[title("followup"), "", onOff(mode)]]);
  } });
  /* Tasks started from chat apps: the owner's lines that let a chat's task use more (GET /api/channels permissions),
     each on or off with the switch that uses them. */
  onDemo17("chatperm", { open: async () => {
    const { permissions } = await api("channels");
    show("chatperm", "", list(permissions?.rules).map((r) => [r.note || r.channel, [r.channel, r.sender, list(r.allow).join(", ")].join(" · "), onOff(permissions.extras)]));
  } });
  /* Messages that always arrive: the outgoing messages still being tried or given up on (GET /api/channels outstanding). */
  onDemo17("delivery", { open: async () => {
    const { outstanding } = await api("channels");
    show("delivery", "", list(outstanding).map((d) => [d.channel, d.lastError || d.preview, d.status === "dead" ? ["no", w("failed")] : ["warn", w("due")]]));
  } });
}
function suggestions() {
  /* Tidy by meaning each night: the merges waiting for the owner's yes (GET /api/memory/proposals, kind "merge"). */
  onDemo17("consolidate", { open: async () => {
    const { proposals } = await api("memory/proposals");
    show("consolidate", "", list(proposals).filter((p) => p.kind === "merge").map((p) => [p.text || p.note, when(p.createdAt), ["warn", w("held-pill")]]));
  } });
  /* Knowledge cards: the cards written up from conversations, waiting for the owner's yes (kind "knowledge-card"). */
  onDemo17("kcards", { open: async () => {
    const { proposals } = await api("memory/proposals");
    show("kcards", "", list(proposals).filter((p) => p.kind === "knowledge-card" && p.card).map((p) => [p.card.title, p.card.body, ["warn", w("held-pill")]]));
  } });
  /* Change settings by talking: the settings a conversation changed (GET /api/settings-kit/history, source "talk"). */
  onDemo17("talksettings", { open: async () => {
    const { records } = await api("settings-kit/history");
    show("talksettings", "", list(records).filter((r) => r.source === "talk").map((r) => [changed(r.changes), when(r.at), r.undoneBy ? null : ["ok", w("done")]]));
  } });
  /* The handbook: its chapters (GET /api/help). */
  onDemo17("handbook", { open: async () => {
    const { chapters } = await api("help");
    show("handbook", "", list(chapters).map((c) => [c.title, "", null]));
  } });
  /* Edit files in Branch: the editor's switch (GET /api/workspace-editor/settings) and, only while it is on, the
     workspace's top folder (GET /api/workspace-editor/list), which the engine refuses while it is off. */
  onDemo17("editor", { open: async () => {
    const { mode } = await api("workspace-editor/settings");
    const listed = on(mode) ? await api("workspace-editor/list") : null;
    show("editor", "", listed ? list(listed.entries).map((e) => [e.name, e.type, null]) : [[title("editor"), "", onOff(mode)]]);
  } });
}

let started = false;
export function initDemosB5() {
  if (started) return;
  started = true;
  money(); models(); permissions(); reach(); care(); advanced(); developer(); guards(); suggestions();
  initTelegramDepth(show);
  render();
}

/* Rows left without a button, and why (the engine has nothing the window could show, or showing it is for the security
   review):
   debate, retired, jev's live answers — the engine keeps no record of challenges or retired-model moves (GET
   /api/second-opinion holds only the debate's limits);
   injection, codecheck — always-on checks with no log to read (the injection policy is the launch file's web section;
   /api/code-check is the project's own check, not the script check in src/code-check.ts);
   screenwatch, jobobj, claims, scratch — no route reads them back (/api/code-run holds a script's limits, not a
   command's; /api/research lists reports, not one brief's numbered sources);
   events, cli, frame — a live stream only, no route, or (frame) the desktop app always draws its own title bar
   (src/desktop/window-chrome-ipc.ts);
   locker, tokens, devpick, hookaddr, voiceapprove — held for the security review: where keys live, sign-in tokens,
   lending a phone's camera or location, addresses that carry a webhook's secret word, and approving by voice. */
