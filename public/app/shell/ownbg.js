/* Your own background behind the glass, 1:1 with the prototype's: a picture, an animation or a video, kept in this
   window's own storage on this computer (IndexedDB) and never sent anywhere, not even to the engine, as the engine's
   own delight code says (src/delight.ts). The storage is the old window's (branch-delight / files / background), so a
   file kept there still shows. The engine keeps only the switch, the scrim and how it fits (POST /api/delight/settings).
   Switching the background off keeps the file; Remove throws it away with the storage for it. A 3D model is not read
   here, so a .glb is not taken. */

export const LIMITS = { picture: 8, animation: 8, video: 25 };
const DB = "branch-delight", STORE = "files", KEY = "background";
export const OWN = { saved: null, url: "" };

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/* One request in its own transaction, done only once the transaction is (a full disk shows up there). */
async function withStore(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error);
    });
  } finally { db.close(); }
}
/* Asking never makes storage for somebody who never chose a file. */
async function stored() {
  const names = await indexedDB.databases?.();
  return !names || names.some((db) => db.name === DB);
}
function show(saved) {
  if (OWN.url) URL.revokeObjectURL(OWN.url);
  OWN.saved = saved?.blob ? saved : null;
  OWN.url = OWN.saved && OWN.saved.kind !== "3d" ? URL.createObjectURL(OWN.saved.blob) : "";
}

/* Read once after sign-in; drawing uses what is in memory. */
export async function loadOwn() {
  show((await stored()) ? await withStore("readonly", (s) => s.get(KEY)) : null);
}

/* Which kind a file is, from its type and, for WebP, whether it moves. Null when it can't go behind the glass here. */
export async function kindOf(file) {
  const type = file.type || "", name = file.name.toLowerCase();
  if (name.endsWith(".glb") || type === "model/gltf-binary") return null;
  if (type.startsWith("video/")) return "video";
  if (type === "image/gif" || type === "image/apng" || name.endsWith(".apng")) return "animation";
  if (type === "image/webp") return new TextDecoder().decode(new Uint8Array(await file.slice(0, 64).arrayBuffer())).includes("ANIM") ? "animation" : "picture";
  if (type.startsWith("image/") && !type.includes("svg")) return "picture";
  return null;
}

export async function keep(file, kind) {
  const saved = { blob: file, kind, name: file.name.slice(0, 120), size: file.size, at: Date.now() };
  await withStore("readwrite", (s) => s.put(saved, KEY));
  show(saved);
}

/* The file goes, and the window's storage for it with it. */
export async function forget() {
  show(null);
  if (!(await stored())) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
