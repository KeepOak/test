/* A phone paired through public/pair.js keeps its own secret beside the key. The paired door can be
   set to ask for it on every request ("this exact phone": src/remote/gateway-auth.ts), so this
   window adds it to every request it makes to its own address. Nothing is added while no secret is
   kept, which is always the case on the computer itself. A live socket cannot carry these headers
   yet; that is left for a later brief. The phone app adds the same headers itself (apps/mobile/web/inject.js). */
export const DEVICE_STORAGE_KEY = "branch-device";

/** The kept { id, key }, or null. */
export function readDevice(storage) {
  try {
    const device = JSON.parse(storage.getItem(DEVICE_STORAGE_KEY) || "null");
    return device && typeof device.id === "string" && typeof device.key === "string" ? device : null;
  } catch {
    return null;
  }
}

/** Keeps what /api/pair handed back, when it handed back a secret for this phone. */
export function keepDevice(storage, answer) {
  if (typeof answer?.deviceId !== "string" || typeof answer?.deviceKey !== "string") return false;
  storage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ id: answer.deviceId, key: answer.deviceKey }));
  return true;
}

const sameOrigin = (url, here) => {
  try { return new URL(String(url), here.href).origin === here.origin; } catch { return false; }
};

/** `fetcher` with this phone's secret added to requests for `here`'s own address. */
export function withDeviceHeaders(fetcher, storage, here) {
  return function deviceFetch(input, init) {
    const device = readDevice(storage);
    const url = input && typeof input === "object" && "url" in input ? input.url : input;
    if (!device || !sameOrigin(url, here)) return fetcher.call(this, input, init);
    const headers = new Headers(init?.headers ?? (input && typeof input === "object" ? input.headers : undefined));
    headers.set("x-branch-device", device.id);
    headers.set("x-branch-device-key", device.key);
    return fetcher.call(this, input, { ...init, headers });
  };
}

/** Called once by public/app/main.js. */
export function installDeviceHeaders(scope = globalThis) {
  if (!scope.fetch || scope.fetch.name === "deviceFetch") return;
  scope.fetch = withDeviceHeaders(scope.fetch.bind(scope), scope.sessionStorage, scope.location);
}
