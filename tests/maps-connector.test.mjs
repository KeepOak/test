/* RES-124: maps requests (src/integrations/maps.ts) ship off, spend the owner's paid plan only after the exact
   coordinates are approved, and an approval is used once, even when the request fails. No Geoapify call is made here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MapsAccess } from "../dist/integrations/maps.js";

test("maps ship off, need terms and a key name, and an exact approval is single use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-maps-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  let fetched = 0;
  const web = new Proxy({}, { get: () => () => { fetched++; throw new Error("no network in this test"); } });
  const maps = new MapsAccess(app.store, app.runtime.owner, web);
  assert.equal(maps.settings().enabled, false, "maps spend a paid plan, so they ship off");
  const request = { kind: "places", centre: { latitude: 48.85, longitude: 2.35 }, radiusMeters: 500, category: "catering.cafe" };
  assert.throws(() => maps.authorize(request), /off or incomplete/);
  assert.throws(() => maps.configure({ enabled: true, keySecret: "GEOAPIFY_KEY" }), /acknowledgement/);
  maps.configure({ enabled: true, termsAndBillingAccepted: true, keySecret: "GEOAPIFY_KEY" });
  const approved = maps.authorize(request);
  assert.match(maps.target("places", approved.requestId), /api\.geoapify\.com\/v2\/places.*one HTTP attempt/);
  assert.throws(() => maps.target("route", approved.requestId), /No matching/, "an approval is for its own kind of request");
  await assert.rejects(maps.request("places", approved.requestId, AbortSignal.timeout(5000)), /No retry/);
  await assert.rejects(maps.request("places", approved.requestId, AbortSignal.timeout(5000)), /owner-approved exact location request is required/,
    "a failed request still used up its approval");
  maps.configure({ enabled: false });
  assert.throws(() => maps.authorize(request), /off or incomplete/);
});
