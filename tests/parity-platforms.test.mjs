/* The Set up panel and the catalog read which systems an added chat service runs on from PARITY_PLATFORMS
   (src/channels/parity-kinds.ts), so they can answer without loading the services. That table must say exactly what the
   services themselves declare (their `platforms`, parity-services.ts); this keeps the two from drifting.
   Mutation: drop `platforms` from iMessage, or add a service's platforms without its row, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { PARITY_PLATFORMS } from "../dist/channels/parity-kinds.js";
import { parityServices } from "../dist/channels/parity-services.js";

test("the platform table agrees with every service's own declared platforms and name", () => {
  const declared = Object.fromEntries(parityServices.filter((service) => service.platforms)
    .map((service) => [service.kind, { name: service.name, platforms: [...service.platforms] }]));
  const table = Object.fromEntries(Object.entries(PARITY_PLATFORMS).map(([kind, row]) => [kind, { name: row.name, platforms: [...row.platforms] }]));
  assert.deepEqual(table, declared);
  assert.deepEqual(table.imessage, { name: "iMessage", platforms: ["darwin"] }, "iMessage runs only on a Mac");
});
