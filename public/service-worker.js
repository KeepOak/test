/**
 * Keeps the app's own files on the phone so opening it again is quick and a dropped connection
 * shows the app rather than a browser error page. Nothing your assistant does is cached: every
 * /api/ request goes straight to your computer and fails honestly when it cannot be reached, which
 * is what puts the offline banner on the screen.
 */
const CACHE = "branch-shell-v2";
const SHELL = [
  "/", "/app.css", "/app/main.js", "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* One missing file must not stop the whole thing being useful. */
      .then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path))))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  /* Anything the assistant does is live or it is nothing; never answer it from a cache. */
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/webhooks/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      /* Only opening the app falls back to the saved page; a missing picture must not become one. */
      .catch(async () => (await caches.match(request))
        ?? (request.mode === "navigate" ? await caches.match("/") : null)
        ?? Response.error()),
  );
});
