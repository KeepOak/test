/* Long waits: a POST /api/run this window keeps open until its task ends, besides the open conversation's own send. A
   browser keeps about six connections to one address, and the event stream, the conversation's own send, the Home panel
   and every other read need theirs, so at most three such waits are held at once, shared by every place that starts
   them (chat/bgsend.js, chat/panes.js). Past that, the place says why and starts nothing. */
const held = new Set();
export const LONG_WAITS = 3;
/** Whether another long wait may start now. */
export const waitRoom = () => held.size < LONG_WAITS;
/** Holds one; the answer lets it go. */
export function holdWait() {
  const key = Symbol("wait");
  held.add(key);
  return () => { held.delete(key); };
}
