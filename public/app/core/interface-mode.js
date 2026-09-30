/* Display-policy/session-reveal approach reviewed in Hermes interface-mode.ts
   (Nous Research, MIT, a9a54245b2311c705d29050b7f9868c015917aec). Original Branch resolver. */
const SIMPLE = { level: "regular", pane: null, home19: false };
const reveals = new Map();
let current = null, unmasked = 0;
function sync(mode, scope) {
  const key = JSON.stringify([mode, scope]);
  if (current !== key) { reveals.clear(); current = key; }
}
export function clearModeReveals() { reveals.clear(); current = null; }
export function modeValue(mode, key, preference, scope) {
  sync(mode, scope);
  if (!mode || unmasked || !Object.hasOwn(SIMPLE, key)) return preference;
  return reveals.has(key) ? reveals.get(key) : SIMPLE[key];
}
/** Returns true when a display choice belongs to this Simple session, rather than saved preferences. */
export function revealModeValue(mode, key, value, scope) {
  sync(mode, scope);
  if (!mode || !Object.hasOwn(SIMPLE, key)) return false;
  reveals.set(key, value);
  return true;
}
/** Synchronous metadata indexing only; authorization and principal state are unchanged. */
export function withoutModePolicy(read) {
  unmasked++;
  try { return read(); } finally { unmasked--; }
}
