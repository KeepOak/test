import { proveOnce } from "../engine-proof.js";

/** Both the database and this engine's authenticated listener must still work after an uncaught failure. */
export async function engineHealthy(database: () => void, origin: string, key: string): Promise<boolean> {
  try { database(); } catch { return false; }
  return (await proveOnce(origin, key, 5000)) !== null;
}
