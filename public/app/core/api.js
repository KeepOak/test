/* Talking to the engine: one fetch helper and one event stream. The desktop app signs every request itself (Electron adds
   the header); in a browser the window uses the session token it was given at sign-in. */

const TOKEN_KEY = "branch-token";
export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY) || "",
  set: (value) => (value ? sessionStorage.setItem(TOKEN_KEY, value) : sessionStorage.removeItem(TOKEN_KEY)),
};
export const isDesktop = new URLSearchParams(location.search).has("desktop");

/* Whether the engine answered last time: requests and the event stream keep it current; onChange redraws the window. */
export const link = { up: true, onChange: null };
function setLink(up) { if (link.up !== up) { link.up = up; link.onChange?.(); } }

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

/* GET when there is no body, POST when there is, unless a method is given. Throws the engine's own error words. */
export async function api(path, body, method, signal) {
  const response = await fetch("/api/" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    cache: "no-store",
    signal,
    headers: headers(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch((error) => { if (error.name !== "AbortError") setLink(false); throw error; });
  setLink(true);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || String(response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

/* POST raw bytes (a recording, a file) with their own content type; answers the engine's JSON or throws its words. */
export async function apiBytes(path, blob) {
  const response = await fetch("/api/" + path, { method: "POST", cache: "no-store", headers: { ...headers(false), "content-type": blob.type || "application/octet-stream" }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || String(response.status)), { status: response.status });
  return data;
}

/* POST JSON and answer the bytes the engine sends back (a reply read aloud); throws the engine's own words. */
export async function apiBlob(path, body) {
  const response = await fetch("/api/" + path, { method: "POST", cache: "no-store", headers: headers(true), body: JSON.stringify(body) });
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
   the window changed or Branch locked). */
export function stream(prefixes, onEvent, onEnd) {
  const controller = new AbortController();
  const wanted = (kind) => !prefixes.length || prefixes.some((p) => kind === p || kind.startsWith(p + "."));
  const once = async () => {
    const response = await fetch("/api/events/stream", { headers: headers(false), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(String(response.status));
    setLink(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = drain(buffer + decoder.decode(value, { stream: true }), (kind, data) => { if (kind === "end") onEnd?.(data); else if (wanted(kind)) onEvent(kind, data); });
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
