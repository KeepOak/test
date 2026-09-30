/* Talking to the engine: one fetch helper and one event stream. The desktop app signs every request itself (Electron adds
   the header); in a browser the window uses the session token it was given at sign-in. */

import { t } from "../../i18n.js";

const TOKEN_KEY = "branch-token";
export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || "",
  set: (value) => (value ? sessionStorage.setItem(TOKEN_KEY, value) : sessionStorage.removeItem(TOKEN_KEY)),
};
export const isDesktop = new URLSearchParams(location.search).has("desktop");

/* Whether the engine answered last time: requests and the event stream keep it current; onChange redraws the window.
   `quiet` while the window knows the engine is going away on purpose (an update installing, the page reloading): the
   swap screen covers that, so nothing is said about it. */
export const link = { up: true, onChange: null, quiet: false };
const waiting = new Set(); // reads that failed, each waiting to be asked once more when the engine answers again
function setLink(up) {
  if (link.up !== up) { link.up = up; if (up) link.quiet = false; link.onChange?.(); } // back: an install's quiet is over
  if (up) { for (const done of waiting) done(); waiting.clear(); }
}
/* The engine is away (a request anywhere failed on the network), for callers outside this file. */
export const engineAway = () => setLink(false);
/* An install or restart the window started: quiet until it is back or the install was refused (`goingAway(false)`). */
export function goingAway(on = true) { link.quiet = on; if (!on) link.onChange?.(); }
addEventListener("pagehide", () => { link.quiet = true; });

/* A request that never reached the engine (it is not running, or is restarting): said in plain words, never the
   browser's own "Failed to fetch". */
export const unreachable = (error) => Object.assign(new Error(t("window.shell.offline")), { offline: true, cause: error });
/* A change that never reached the engine: said plainly that it was not done (Q063: Lockdown pressed while Branch was not
   running must never look done), where a read says nothing and is asked again. */
const notDone = (error) => Object.assign(new Error(t("window.shell.offline-not-done")), { offline: true, notDone: true, cause: error });
/* Resolves once the engine answers again (at once when it is answering now). */
export const whenBack = () => (link.up ? Promise.resolve() : new Promise((done) => waiting.add(done)));
/* A read that failed on the network waits for the engine to answer again (at most a minute), then is asked once more. */
const backAgain = () => new Promise((done) => { waiting.add(done); setTimeout(() => { waiting.delete(done); done(); }, 60_000); });

/* Every request says whether setup (flows/setup.js) is open: what setup asks for is first-run configuration, which the
   engine never counts toward achievements, and a request from outside setup tells it setup is over (src/setup-origin.ts). */
export const origin = { setup: false };

function headers(json) {
  const out = {};
  const value = token.get();
  if (value) out.authorization = "Bearer " + value;
  out["x-branch-origin"] = origin.setup ? "setup" : "window";
  if (json) out["content-type"] = "application/json";
  return out;
}

/* Whoever needs the owner's comfort choices the moment they are saved (shell/autoupdate.js: switching update by itself
   on in any page takes effect at once, not at the next refresh). Called with the values each successful POST
   /api/comfort answers. */
export const comfortSaved = new Set();
/* UP-UI-050: how many engine answers have come back, so settings/find.js knows when what it drew may be out of date. */
export const answers = { n: 0 };

/* GET when there is no body, POST when there is, unless a method is given. Throws the engine's own error words. */
export async function api(path, body, method, signal) {
  return ask(path, body, method, signal, true);
}
async function ask(path, body, method, signal, again) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  let response;
  try {
    response = await fetch("/api/" + path, {
      method: verb, cache: "no-store", signal, headers: headers(body !== undefined), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    setLink(false);
    // A read is asked again once the engine is back; a change is never sent twice by itself.
    if (again && verb === "GET" && !link.quiet && !signal?.aborted) {
      await backAgain();
      if (link.up && !signal?.aborted) return ask(path, body, method, signal, false);
    }
    throw verb === "GET" ? unreachable(error) : notDone(error);
  }
  setLink(true);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || String(response.status));
    error.status = response.status;
    throw error;
  }
  if (path === "comfort" && body !== undefined && data?.values) for (const heard of comfortSaved) heard(data.values);
  if (!path.startsWith("search?")) answers.n += 1; // the Ctrl K palette's own search is not something Settings draws from
  return data;
}

/* POST raw bytes (a recording, a file) with their own content type; answers the engine's JSON or throws its words. */
export async function apiBytes(path, blob) {
  const response = await fetch("/api/" + path, { method: "POST", cache: "no-store", headers: { ...headers(false), "content-type": blob.type || "application/octet-stream" }, body: blob })
    .catch((error) => { setLink(false); throw notDone(error); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  return data;
}

/* Sends one file ahead of its message (POST /api/attachments/upload): the browser streams it, the engine writes it to
   disk as it arrives. XMLHttpRequest rather than fetch because only it reports how much has really gone (onProgress gets
   the bytes the browser has sent and the total). Answers { promise, abort }; the promise gives the engine's view of the
   file or throws its own words. */
export function uploadFile(file, name, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((done, fail) => {
    const type = file.type || "application/octet-stream";
    xhr.open("POST", `/api/attachments/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`);
    for (const [key, value] of Object.entries(headers(false))) xhr.setRequestHeader(key, value);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not the engine's JSON: its status says what happened */ }
      if (xhr.status >= 200 && xhr.status < 300) done(data);
      else fail(Object.assign(new Error(data.error || String(xhr.status)), { status: xhr.status }));
    };
    // A file that could not reach the engine says so in the window's own words, never a bare status.
    xhr.onerror = () => { setLink(false); fail(unreachable(new Error(String(xhr.status || "network")))); };
    xhr.onabort = () => fail(Object.assign(new Error("aborted"), { aborted: true }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/* POST JSON and answer the bytes the engine sends back (a reply read aloud); throws the engine's own words. */
export async function apiBlob(path, body) {
  const response = await fetch("/api/" + path, { method: "POST", cache: "no-store", headers: headers(true), body: JSON.stringify(body) })
    .catch((error) => { setLink(false); throw unreachable(error); });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  }
  return response.blob();
}

/* Server-sent events over fetch (EventSource cannot carry the header). The engine names events exactly ("run.started"),
   so the window takes them all and keeps those whose kind starts with one of `prefixes`. The engine closes a stream after a
   while; this opens the next one, so live updates never quietly stop. Calls onEvent(kind, payload) until stopped, and
   onEnd(payload) with the engine's own "end" of each connection (src/streams.ts: { reason: "profile" } when the person at
   the window changed; locking Branch does not end it). */
export function stream(prefixes, onEvent, onEnd) {
  const controller = new AbortController();
  const wanted = (kind) => !prefixes.length || prefixes.some((p) => kind === p || kind.startsWith(p + "."));
  /* hot-update: a stream opened again asks for what came after the last event it had, so nothing that happened while it
     reconnected (an engine handed over, a restart) is missed. */
  let last = null;
  const once = async () => {
    const response = await fetch(last === null ? "/api/events/stream" : `/api/events/stream?after=${last}`, { headers: headers(false), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(String(response.status));
    setLink(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = drain(buffer + decoder.decode(value, { stream: true }), (kind, data) => {
        const seen = kind === "end" ? data?.after : data?.id;
        if (Number.isInteger(seen) && seen > (last ?? 0)) last = seen;
        if (kind === "end") onEnd?.(data); else if (wanted(kind)) onEvent(kind, data);
      });
    }
  };
  const run = async () => {
    let wait = 500;
    while (!controller.signal.aborted) {
      try { await once(); wait = 500; } catch (error) { if (error.name === "AbortError") return; setLink(false); wait = Math.min(wait * 2, 15000); }
      await new Promise((done) => setTimeout(done, wait));
    }
  };
  const done = run();
  return { stop: () => controller.abort(), done };
}

/* One task's own stream (GET /api/<path>, e.g. runs/<id>/live), read once to its end: onEvent(kind, payload) for each
   event, the engine's "end" included. Throws the answer's status when it is refused; the caller decides whether to open
   it again. */
export async function streamOnce(path, onEvent, signal) {
  const response = await fetch("/api/" + path, { headers: headers(false), signal });
  if (!response.ok || !response.body) throw Object.assign(new Error(String(response.status)), { status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = drain(buffer + decoder.decode(value, { stream: true }), onEvent);
  }
}

function drain(buffer, onEvent) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let kind = "message";
    let payload = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("data:")) payload += line.slice(5).trim();
    }
    if (!payload || kind === "ready") continue;
    try { onEvent(kind, JSON.parse(payload)); } catch { /* a half-written block is ignored */ }
  }
  return rest;
}
