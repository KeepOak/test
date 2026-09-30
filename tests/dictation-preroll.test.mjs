// The first syllable is not lost: quiet pieces before speech are held (up to half a second) and
// handed on the moment speech is heard, and nothing is held once speech has started.
import test from "node:test";
import assert from "node:assert/strict";
import { DictationPreroll } from "../dist/voice-dictation-preroll.js";

const piece = (n) => new Uint8Array([n]);

test("pieces before speech are held, then handed on in order when speech starts", () => {
  const preroll = new DictationPreroll();
  const out = [];
  for (let n = 0; n < DictationPreroll.frames + 2; n += 1) out.push(...preroll.push(piece(n), false));
  assert.deepEqual(out.map((p) => p[0]), [0, 1], "only what is older than the look-behind is passed on early");
  const released = preroll.push(piece(99), true).map((p) => p[0]);
  assert.equal(released.length, DictationPreroll.frames + 1);
  assert.deepEqual(released.slice(0, 2), [2, 3]);
  assert.equal(released.at(-1), 99, "the speech itself comes last");
  assert.deepEqual(preroll.push(piece(7), false).map((p) => p[0]), [7], "after speech nothing is held back");
  preroll.forget();
  assert.deepEqual(preroll.push(piece(8), false), [], "a forgotten phrase starts holding again");
});
