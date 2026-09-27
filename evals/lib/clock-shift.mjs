/**
 * The evals' simulated clock, preloaded into one engine process with `node --import`. It moves that process's Date
 * forward by EVAL_CLOCK_OFFSET_MS, so "remember this, then recall it three days later" is three days later for
 * everything the engine does (memory timestamps, recency, schedules). Only the eval harness ever loads this file.
 */
const offset = Number(process.env.EVAL_CLOCK_OFFSET_MS ?? 0);
if (Number.isFinite(offset) && offset !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(realNow() + offset).toString();
    return Reflect.construct(RealDate, args.length ? args : [realNow() + offset], new.target);
  }
  ShiftedDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.now = () => realNow() + offset;
  globalThis.Date = ShiftedDate;
}
