/** Compatibility for browsers which installed the old /service-worker.js. The current
 * window registers no offline shell. There is no fetch handler, cache creation, or
 * replacement registration: this worker retires only itself and exact historical
 * Branch shell caches (v1/v2/v3), leaving unrelated origin storage untouched. */
export const retiredPhoneWorker = `
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.allSettled(
    ["branch-shell-v1", "branch-shell-v2", "branch-shell-v3"].map((name) => caches.delete(name))
  ).then(() => self.registration.unregister()));
});
`;
