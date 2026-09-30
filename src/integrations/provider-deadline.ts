/** Bounds waiting for local credentials too; late work must still check this signal before sending. */
export async function withinProviderSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error("Provider request cancelled or timed out"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}
