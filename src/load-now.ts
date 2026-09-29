import { createRequire } from "node:module";

/**
 * PLAT-191: a part of Branch loaded the moment it is first needed, synchronously, so everything that uses it keeps its
 * ordinary shape (a property, a call). Node loads an ES module this way when nothing in it waits at the top level.
 * `specifier` is relative to the built folder's root (dist/), as "./personal/index.js".
 */
const require = createRequire(new URL("./", import.meta.url));
export function loadNow<T>(specifier: string): T {
  return require(specifier) as T;
}
