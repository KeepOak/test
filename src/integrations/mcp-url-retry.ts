/** Only the protocol's explicit URL-required error permits one owner-reviewed retry. */
export async function urlRequiredRetry<T>(invoke: () => Promise<T>,
  expected: (error: unknown) => error is { code: number; data?: unknown },
  review: (elicitations: unknown) => Promise<void>): Promise<T> {
  try { return await invoke(); }
  catch (error) {
    if (!expected(error) || error.code !== -32042) throw error;
    const data = error.data;
    if (!data || typeof data !== 'object' || !('elicitations' in data))
      throw new Error('The server omitted its required browser questions.');
    await review(data.elicitations);
    // A second URL error or ambiguous transport failure escapes; this is never a retry loop.
    return invoke();
  }
}
